// Live prices from the TWS on this computer, over its local API socket.
//
// Nothing here needs keys or logins: TWS itself holds your IB session. The
// terminal keeps one connection open (set TWS_PORT if your API port isn't
// 7496) and only ever asks for past bars — it never places orders.
// US stocks and ETFs.
//
// Wire layout follows IB's own 9.81 client: no version field on modern
// servers, full contract block, bar size before duration, useRTH before
// whatToShow, keepUpToDate, then one Key=Value options string.

import net from "node:net";
import { health } from "./providers.js";
import {
  parseTf,
  resample,
  nativeBase,
} from "../public/lib/series.js";

const PORTS = (process.env.TWS_PORTS
  ? process.env.TWS_PORTS.split(",")
      .map(Number)
      .filter(Number.isFinite)
  : [Number(process.env.TWS_PORT) || 7496, 7496, 7497]
).filter((p, i, a) => a.indexOf(p) === i);
const HOST = process.env.TWS_HOST || "127.0.0.1";
const CLIENT_ID = Number(process.env.TWS_CLIENT_ID) || 9101;
const TIMEOUT_MS = 25000;

const TWS_NATIVE = {
  "1m": "1 min",
  "2m": "2 mins",
  "3m": "3 mins",
  "5m": "5 mins",
  "10m": "10 mins",
  "15m": "15 mins",
  "20m": "20 mins",
  "30m": "30 mins",
  "1h": "1 hour",
  "2h": "2 hours",
  "4h": "4 hours",
  "8h": "8 hours",
  "1D": "1 day",
  "1W": "1 week",
  "1M": "1 month",
};

function mark(ok, err) {
  health.tws = {
    ok,
    at: new Date().toISOString(),
    ...(err ? { error: String(err.message || err).slice(0, 200) } : {}),
  };
}

const twsError = (message) =>
  Object.assign(new Error(message), { status: 502, upstream: true });

// ---------- connection ----------

let sock = null;
let buf = Buffer.alloc(0);
let serverVersion = 0;
let goodPort = 0;
let nextReqId = 5000;
let lastSentAt = 0;
const pending = new Map(); // reqId -> { resolve, reject, timer, bars, label }

function sendMsg(fields) {
  const body = Buffer.from(fields.join("\0") + "\0", "utf8");
  const head = Buffer.alloc(4);
  head.writeInt32BE(body.length, 0);
  sock.write(Buffer.concat([head, body]));
}

function failAll(e) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(e);
  }
  pending.clear();
}

function onData(chunk) {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readInt32BE(0);
    if (len < 0 || len > 50 * 1024 * 1024) {
      buf = Buffer.alloc(0);
      return;
    }
    if (buf.length < 4 + len) return;
    const fields = buf
      .slice(4, 4 + len)
      .toString("utf8")
      .split("\0")
      .filter((f) => f !== "");
    buf = buf.slice(4 + len);
    route(fields);
  }
}

function route(fields) {
  const id = fields[0];
  if (id === "17") {
    // Historical data: version? no — modern servers send
    // reqId, startDate, endDate, barCount, then bars of
    // date, open, high, low, close, volume, WAP, count.
    const reqId = Number(fields[1]);
    const p = pending.get(reqId);
    if (!p) return;
    const n = Number(fields[4]);
    const rest = fields.slice(5);
    const per = n > 0 ? rest.length / n : 0;
    const step = per >= 8 ? 8 : 7;
    const bars = [];
    for (let i = 0; i < n; i++) {
      const b = rest.slice(i * step, i * step + step);
      if (b.length < 7) continue;
      const time = twsEpoch(b[0]);
      if (!Number.isFinite(time)) continue;
      bars.push({
        time,
        open: Number(b[1]),
        high: Number(b[2]),
        low: Number(b[3]),
        close: Number(b[4]),
        volume: Number(b[5]) || 0,
      });
    }
    p.bars = bars;
    finish(reqId);
  } else if (id === "18") {
    // End marker; the bars already arrived in message 17.
    finish(Number(fields[1]));
  } else if (id === "4") {
    // Error: version, reqId, code, text. Farm chatter (21xx) is ignored.
    const reqId = Number(fields[1]);
    const code = Number(fields[2]);
    const text = fields.slice(3).join(" ");
    const p = pending.get(reqId);
    if (!p) return;
    if (code >= 2100 && code < 2200) return;
    clearTimeout(p.timer);
    pending.delete(reqId);
    const err = twsError(friendlyError(code, text));
    err.twsCode = code;
    p.reject(err);
  }
  // Messages 9 (next id), 15 (accounts) and the rest need no action.
}

function finish(reqId) {
  const p = pending.get(reqId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(reqId);
  p.resolve(p.bars || []);
}

function friendlyError(code, text) {
  if (code === 162 && /pacing/i.test(text))
    return "TWS says slow down (too many requests at once)";
  if (code === 162 && /no data/i.test(text))
    return "TWS has no bars for that symbol and timeframe";
  if (code === 200) return `TWS doesn't know that symbol (${text})`;
  if (code === 354 || /not subscribed/i.test(text))
    return "TWS needs a live subscription for those bars";
  return `TWS refused (${text || `code ${code}`})`;
}

function connectOnce(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, HOST);
    const fail = (e) => {
      s.destroy();
      reject(e);
    };
    s.once("error", fail);
    s.once("connect", () => {
      s.write("API\0");
      const v = Buffer.from("v100..180", "utf8");
      const head = Buffer.alloc(4);
      head.writeInt32BE(v.length, 0);
      s.write(Buffer.concat([head, v]));
      let pre = Buffer.alloc(0);
      const onFirst = (chunk) => {
        pre = Buffer.concat([pre, chunk]);
        if (pre.length < 4) return;
        const len = pre.readInt32BE(0);
        if (len < 0 || len > 1024 || pre.length < 4 + len) {
          if (pre.length > 2048) {
            s.destroy();
            reject(new Error("bad handshake"));
          }
          return;
        }
        const parts = pre
          .slice(4, 4 + len)
          .toString("utf8")
          .split("\0")
          .filter((f) => f !== "");
        s.removeListener("data", onFirst);
        s.removeListener("error", fail);
        serverVersion = Number(parts[0]) || 0;
        resolve({ sock: s, rest: pre.slice(4 + len) });
      };
      s.on("data", onFirst);
      setTimeout(() => fail(new Error("TWS didn't answer the handshake")), 8000);
    });
  });
}

async function ensure() {
  if (sock && !sock.destroyed) return;
  buf = Buffer.alloc(0);
  let lastErr = null;
  for (const port of goodPort ? [goodPort, ...PORTS.filter((p) => p !== goodPort)] : PORTS) {
    try {
      const { sock: s, rest } = await connectOnce(port);
      sock = s;
      goodPort = port;
      sock.on("data", onData);
      sock.on("error", () => {
        sock = null;
        failAll(twsError("The TWS connection dropped"));
      });
      sock.on("close", () => {
        if (sock === s) sock = null;
      });
      if (rest.length) onData(rest);
      sendMsg(["71", "2", String(CLIENT_ID), ""]); // START_API
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw twsError(
    lastErr?.code === "ECONNREFUSED" || /refused/i.test(lastErr?.message || "")
      ? "TWS isn't running on this computer (open TWS and enable API connections)"
      : `TWS couldn't be reached (${lastErr?.message || lastErr})`,
  );
}

// Small gap between requests keeps TWS happy when several charts load at once.
async function pace() {
  const gap = Date.now() - lastSentAt;
  if (gap < 300) await new Promise((r) => setTimeout(r, 300 - gap));
  lastSentAt = Date.now();
}

function requestHistorical({ symbol, endDateTime, duration, bar, whatToShow, useRTH }) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensure();
    } catch (e) {
      return reject(e);
    }
    const reqId = ++nextReqId;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(twsError("TWS took too long to answer"));
    }, TIMEOUT_MS);
    pending.set(reqId, { resolve, reject, timer, bars: null });
    try {
      await pace();
      sendMsg([
        "20",
        String(reqId),
        "0", // conId: let TWS resolve the ticker
        symbol,
        "STK",
        "", // expiry
        "", // strike
        "", // right
        "", // multiplier
        "SMART",
        "", // primary exchange
        "USD",
        "", // local symbol
        "", // trading class
        "0", // includeExpired
        endDateTime,
        bar,
        duration,
        String(useRTH),
        whatToShow,
        "1", // formatDate: text dates with timezone
        "0", // keepUpToDate
        "", // chart options
      ]);
    } catch (e) {
      clearTimeout(timer);
      pending.delete(reqId);
      reject(e);
    }
  });
}

// ---------- time ----------

const dtfCache = new Map();
// "20261015 15:30:00 Europe/Brussels" -> unix seconds. TWS names the zone,
// so daylight saving is handled for us.
export function twsEpoch(s) {
  const str = String(s || "").trim();
  // Daily bars arrive as a bare date; midnight UTC, like the other sources.
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(str);
  if (d) return Math.floor(Date.UTC(+d[1], +d[2] - 1, +d[3]) / 1000);
  const m = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})(?: (.*))?$/.exec(
    String(s || "").trim(),
  );
  if (!m) return NaN;
  const [, Y, Mo, D, h, mi, sec, tz] = m;
  const wall = Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +sec);
  if (!tz) return Math.floor(wall / 1000);
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    try {
      dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return Math.floor(wall / 1000);
    }
    dtfCache.set(tz, dtf);
  }
  const parts = {};
  for (const p of dtf.formatToParts(new Date(wall))) parts[p.type] = p.value;
  const asUTC = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour % 24,
    +parts.minute,
    +parts.second,
  );
  return Math.floor((wall - (asUTC - wall)) / 1000);
}

// ---------- public ----------

function durationFor(tfSeconds, limit) {
  // Trading time needed, with slack. IB caps duration per bar size, so ask
  // in steps it accepts: days for intraday, years for daily and above.
  if (tfSeconds >= 86400) {
    const years = Math.ceil(((limit * tfSeconds) / 86400 / 252) * 1.3);
    return `${Math.min(Math.max(years, 1), 20)} Y`;
  }
  const sessions = Math.ceil(((limit * tfSeconds) / 23400) * 1.4);
  if (sessions <= 1) return "1 D";
  if (sessions <= 5) return `${sessions} D`;
  const weeks = Math.ceil(sessions / 5);
  if (weeks <= 3) return `${weeks} W`;
  return `${Math.min(Math.ceil(weeks / 4.3), 12)} M`;
}

export async function twsCandles(ticker, tf, limit) {
  const base = nativeBase(tf, Object.keys(TWS_NATIVE));
  if (!base) throw twsError(`TWS can't build a ${tf} chart`);
  const secs = parseTf(tf).seconds;
  const bar = TWS_NATIVE[base];
  const duration = durationFor(secs, limit);
  const useRTH = 1;
  let bars;
  try {
    bars = await requestHistorical({
      symbol: ticker.toUpperCase(),
      endDateTime: "",
      duration,
      bar,
      whatToShow: "TRADES",
      useRTH,
    });
  } catch (e) {
    mark(false, e);
    // Without a live subscription TWS withholds TRADES bars; MIDPOINT still
    // draws the chart, just without volume.
    if (e.twsCode === 354 || /subscri/i.test(e.message)) {
      try {
        bars = await requestHistorical({
          symbol: ticker.toUpperCase(),
          endDateTime: "",
          duration,
          bar,
          whatToShow: "MIDPOINT",
          useRTH,
        });
        bars = bars.map((b) => ({ ...b, volume: 0 }));
      } catch (e2) {
        mark(false, e2);
        throw e2;
      }
    } else {
      throw e;
    }
  }
  if (!bars.length) {
    const err = twsError(`TWS returned no ${ticker} bars`);
    mark(false, err);
    throw err;
  }
  bars.sort((a, b) => a.time - b.time);
  mark(true);
  return base === tf ? bars.slice(-limit) : resample(bars, tf).slice(-limit);
}

export async function probeTws() {
  try {
    await ensure();
    return { ok: true, version: serverVersion };
  } catch (e) {
    return { ok: false, optional: true, error: e.message };
  }
}
