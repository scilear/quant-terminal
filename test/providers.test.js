// Provider fallbacks with a fake network: no live calls. Each case is a real bug found by
// blocking hosts: Binance blocked made "BTCUSDT" resolve to a US stock, and a firewall that
// silently drops Binance cost a full timeout on every chart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.QT_TIMEOUT_MS = "300";
const btc = JSON.parse(
  readFileSync(new URL("./fixtures/btc-1d.json", import.meta.url), "utf8"),
);
let mode = {}; // host -> 'drop' | 'dns' | status code
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  calls.push(u.host);
  const m = mode[u.host] ?? mode["*"];
  if (m === "drop") {
    // A real dropped connection holds a socket open. The fake one has nothing keeping the event
    // loop alive, and Node before 24 unrefs AbortSignal.timeout, so hold a timer until the abort.
    const keepAlive = setTimeout(() => {}, 10000);
    return new Promise((_, rej) =>
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        rej(opts.signal.reason);
      }),
    );
  }
  if (m === "dns")
    throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
  if (m) return new Response("blocked", { status: m });
  if (u.host === "api.exchange.coinbase.com") {
    const end = Date.parse(u.searchParams.get("end")) / 1000;
    const rows = btc
      .filter((b) => b.time < end)
      .slice(-300)
      .reverse()
      .map((b) => [b.time, b.low, b.high, b.open, b.close, b.volume]);
    return Response.json(rows);
  }
  return new Response("not mocked", { status: 404 });
};
const P = await import("../lib/providers.js");

test("with Binance blocked, crypto still resolves as crypto and loads from Coinbase", async () => {
  mode = {
    "api.binance.com": 451,
    "data-api.binance.vision": 451,
    "api.binance.us": 451,
  };
  for (const s of ["BTCUSDT", "btc", "ETH-USD", "SOL/USDT"])
    assert.equal((await P.resolve(s)).exchange, "BINANCE", s);
  assert.equal((await P.resolve("AAPL")).exchange, "US");
  const r = await P.getCandles("BTCUSDT", "1D", 100);
  assert.equal(r.provider, "Coinbase");
  assert.equal(r.candles.length, 100);
});

test("a silently dropped host costs one timeout, then is skipped", async () => {
  mode = {
    "api.binance.com": "drop",
    "data-api.binance.vision": "drop",
    "api.binance.us": "drop",
  };
  let t = Date.now();
  const a = await P.getCandles("BINANCE:ETHUSDT", "1D", 50);
  assert.equal(a.provider, "Coinbase");
  assert.ok(
    Date.now() - t < 1500,
    `first fallback took ${Date.now() - t} ms (three hosts should time out together)`,
  );
  t = Date.now();
  calls.length = 0;
  const b = await P.getCandles("BINANCE:SOLUSDT", "1D", 50);
  assert.equal(b.provider, "Coinbase");
  assert.ok(Date.now() - t < 200, "second chart skips the dead hosts");
  assert.ok(
    !calls.some((h) => h.includes("binance")),
    "no new Binance calls while it is marked down",
  );
});

test("network failures are upstream errors (the server answers 502)", async () => {
  mode = { "*": "dns" };
  await assert.rejects(P.economicCalendar(), (e) => e.upstream === true);
});

test("the chart note for a fallback is plain words: no hostnames or HTTP codes", async () => {
  // A Skool member saw "Using Kraken (Yahoo: query1.finance.yahoo.com returned HTTP 429)" on a chart and had to ask what it meant.
  mode = { "api.binance.com": 451, "data-api.binance.vision": 451, "api.binance.us": 451 };
  const r = await P.getCandles("BTCUSDT", "1D", 100);
  const text = r.notes.join(" ");
  assert.match(text, /Binance isn't answering right now, so this chart uses Coinbase\./);
  assert.doesNotMatch(text, /HTTP|\.com|returned/);
});

test("Kraken pairs are keyed by the names everyone else uses (BTC, DOGE), valued by Kraken's own", async () => {
  const { krakenPairMap } = await import("../lib/providers.js");
  const m = krakenPairMap({
    XXBTZUSD: { altname: "XBTUSD", wsname: "XBT/USD", status: "online" },
    XDGUSD: { altname: "XDGUSD", wsname: "XDG/USD", status: "online" },
    SOLUSD: { altname: "SOLUSD", wsname: "SOL/USD", status: "online" },
    OLDUSD: { altname: "OLDUSD", wsname: "OLD/USD", status: "delisted" },
  });
  assert.equal(m.get("BTCUSD"), "XBTUSD");
  assert.equal(m.get("DOGEUSD"), "XDGUSD");
  assert.equal(m.get("SOLUSD"), "SOLUSD");
  assert.equal(m.has("OLDUSD"), false);
});

test("XAUUSD charts gold, and falls back to PAXG when Yahoo is down", async () => {
  mode = { "query1.finance.yahoo.com": 429, "query2.finance.yahoo.com": 429 };
  for (const s of ["XAUUSD", "xau/usd", "FX:XAUUSD"])
    assert.equal((await P.resolve(s)).id, "FX:XAUUSD", s);
  assert.equal((await P.resolve("XAGUSD")).id, "FX:XAGUSD");
  assert.equal((await P.resolve("GOLD")).exchange, "US", "Barrick's ticker stays a stock");
  calls.length = 0;
  const r = await P.getCandles("XAUUSD", "1D", 50).catch((e) => e);
  assert.ok(
    calls.some((h) => h.includes("binance") || h.includes("coinbase")),
    "gold tries the PAXG token feeds after Yahoo",
  );
  if (!(r instanceof Error)) assert.ok(r.notes.some((n) => n.includes("PAXG")));
});

const DAY = 86400;
const day = (y, m, d) => Date.UTC(y, m, d) / 1000;

const actionsFixture = () => ({
  chart: {
    result: [
      {
        meta: { gmtoffset: 0 },
        timestamp: [day(2020, 7, 28), day(2020, 7, 31), day(2020, 8, 1)],
        indicators: {
          quote: [
            {
              open: [100, 25, 25.5],
              high: [101, 26, 26],
              low: [99, 24, 25],
              close: [100, 25, 26],
              volume: [1000, 4000, 4100],
            },
          ],
          adjclose: [{ adjclose: [100, 24.5, 25.48] }],
        },
        events: {
          splits: {
            1: {
              date: day(2020, 7, 31) + 13.5 * 3600,
              numerator: 4,
              denominator: 1,
              splitRatio: "4:1",
            },
          },
          dividends: {
            2: { date: day(2020, 8, 1) + 13.5 * 3600, amount: 0.5 },
          },
        },
      },
    ],
  },
});

test("adjusted bars follow adjclose; raw bars undo the split and mark the events", () => {
  const f = actionsFixture();
  const adj = P.parseYahoo(f, "1D", true);
  assert.equal(adj[0].close, 100, "no dividend yet, so adjclose equals close");
  assert.equal(adj[1].close, 24.5, "adjclose is used for the adjusted chart");

  const rawBars = P.parseYahoo(f, "1D", false);
  const raw = P.applySplits(rawBars, rawBars.events.splits);
  assert.equal(raw[0].close, 400, "pre-split bar shows its real pre-split price");
  assert.equal(raw[0].volume, 250, "volume comes back down by the split ratio");
  assert.equal(raw[1].close, 25, "the split day itself is already on the new basis");

  const ev = P.parseActions(f);
  assert.equal(ev.splits.length, 1);
  assert.equal(ev.splits[0].ratio, 4);
  assert.equal(ev.splits[0].label, "4:1");
  assert.equal(ev.dividends[0].amount, 0.5);
});

test("dividend adjustment only lowers prices before the ex-date", () => {
  const bars = [
    { time: day(2020, 0, 1), open: 100, high: 101, low: 99, close: 100 },
    { time: day(2020, 0, 2), open: 99, high: 100, low: 98, close: 99 },
    { time: day(2020, 0, 3), open: 99, high: 100, low: 98, close: 99.5 },
  ];
  const out = P.adjustForDividends(bars, [
    { time: day(2020, 0, 2) + 13.5 * 3600, amount: 1 },
  ]);
  assert.equal(out[0].close, 99, "1 on a 100 close is a 1% adjustment");
  assert.equal(out[0].open, 99);
  assert.equal(out[1].close, 99, "the ex-date bar is not adjusted");
  assert.equal(out[2].close, 99.5);
});

test("a dividend on split-adjusted bars is brought onto the current share basis first", () => {
  // Nasdaq history is split-adjusted; a $1 dividend paid before a 4:1 split is $0.25 on the
  // prices shown today. Without that, old dividends would be over-weighted four times.
  const bars = [
    { time: day(2020, 0, 1), open: 100, high: 101, low: 99, close: 100 },
    { time: day(2020, 0, 2), open: 100, high: 101, low: 99, close: 100 },
    { time: day(2020, 0, 3), open: 100, high: 101, low: 99, close: 100 },
  ];
  const out = P.adjustForDividends(
    bars,
    [{ time: day(2020, 0, 2) + 13.5 * 3600, amount: 1 }],
    [{ time: day(2020, 0, 3) + 13.5 * 3600, ratio: 4 }],
  );
  assert.equal(out[0].close, 99.75, "$1 / 4 = $0.25 off a $100 close");
});
