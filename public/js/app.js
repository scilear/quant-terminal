import { api, download, esc, ticker, exchange } from "./api.js";
import { ChartPane, CHART_TYPES, newUid } from "./chart.js";
import { TOOLS } from "./drawings.js";
import {
  INDICATORS,
  BY_ID,
  registerIndicator,
  compute,
} from "../lib/indicators.js";
import { parseTf, isIntraday, toCsv } from "../lib/series.js";
import { contrastingColor } from "./zones.js";
import { initPanels } from "./panels.js";

const $ = (s, el = document) => el.querySelector(s);
// Another app that once ran on this port can leave a service worker or a cache behind. A normal
// window trusts them and keeps serving that stale copy (a private window ignores them, which is
// why the terminal can "only work in private mode"). Neither belongs to this app, so drop them.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => Promise.all(regs.map((r) => r.unregister())))
    .then((gone) => {
      if (globalThis.caches) caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).catch(() => {});
      if (gone.includes(true) && navigator.serviceWorker.controller && !sessionStorage.getItem("qt-sw-reset")) {
        sessionStorage.setItem("qt-sw-reset", "1");
        location.reload();
      }
    })
    .catch(() => {});
}
const TF_QUICK = ["1m", "5m", "15m", "1h", "4h", "1D", "1W"];
const LAYOUTS = { 1: 1, "2v": 2, "2h": 2, 3: 3, 4: 4, 6: 6, 8: 8, 16: 16 };
const DEFAULT_WATCHLISTS = {
  Main: [
    "BINANCE:BTCUSDT",
    "BINANCE:ETHUSDT",
    "BINANCE:SOLUSDT",
    "US:AAPL",
    "US:NVDA",
    "US:SPY",
    "US:QQQ",
    "FX:EURUSD",
  ],
};

class App {
  constructor() {
    this.panes = [];
    this.active = null;
    this.tool = "cursor";
    this.prices = {};
    this.priceListeners = new Set();
    this.saveTimer = null;
  }

  async init() {
    let state = {};
    try {
      state = await api.get("/api/state");
    } catch {
      /* first run */
    }
    this.state = {
      layout: "1",
      panes: [
        {
          symbol: "BINANCE:BTCUSDT",
          tf: "1D",
          type: "candles",
          indicators: [
            { uid: newUid(), id: "ema", params: { length: 21 } },
            { uid: newUid(), id: "rsi", params: {} },
          ],
        },
      ],
      watchlists: DEFAULT_WATCHLISTS,
      activeWatchlist: "Main",
      drawings: {},
      settings: {},
      paper: null,
      strategies: {},
      workspaces: [],
      activeWorkspace: null,
      indicatorDefaults: {},
      ...state,
    };
    this.state.workspaces ||= [];
    this.state.indicatorDefaults ||= {};
    this.settings = {
      theme: "dark",
      volume: true,
      bars: 3000,
      utc: false,
      stayInDrawMode: false,
      syncSymbol: false,
      syncTf: false,
      syncCrosshair: false,
      dailySrc: "auto",
      intradaySrc: "auto",
      ...this.state.settings,
    };
    this.state.settings = this.settings;
    // Charts ask the server for candles through api.candles; this hook tells
    // every request which source the Settings pickers chose for its timeframe.
    api.srcFor = (tf) =>
      isIntraday(tf)
        ? this.settings.intradaySrc || "auto"
        : this.settings.dailySrc || "auto";
    document.documentElement.dataset.theme = this.settings.theme;
    await this.loadCustomIndicators();
    this.buildToolbar();
    this.buildDrawbar();
    this.setLayout(this.state.layout, false);
    this.panels = initPanels(this);
    this.bindKeys();
    this.listenAlerts();
    this.checkHealth();
    setInterval(() => this.checkHealth(), 60000);
  }

  // ---------- persistence ----------
  persist() {
    this.state.panes = this.panes.map((p) => p.cfg);
    this.state.active = this.panes.indexOf(this.active);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(
      () =>
        api
          .put("/api/state", this.state)
          .catch((e) => this.toast(`Couldn't save: ${e.message}`, "err")),
      400,
    );
  }
  getDrawings(symbol) {
    return structuredClone(this.state.drawings[symbol] || []);
  }
  saveDrawings(symbol, items) {
    this.state.drawings[symbol] = items.map(
      ({ id, type, points, text, color, rr }) => ({
        id,
        type,
        points,
        text,
        color,
        rr,
      }),
    );
    for (const p of this.panes)
      if (p.cfg.symbol === symbol && p.drawings.items !== items)
        p.drawings.setItems(this.getDrawings(symbol));
    this.persist();
  }

  // ---------- custom indicators ----------
  async loadCustomIndicators() {
    try {
      const list = await api.get("/api/custom");
      for (const c of list) await this.importCustom(c.file, c.mtime);
    } catch {
      /* none */
    }
  }
  async importCustom(file, v = Date.now()) {
    try {
      const mod = await import(`/custom/${encodeURIComponent(file)}?v=${v}`);
      return registerIndicator({
        ...mod.default,
        id: `custom:${file.replace(/\.js$/, "")}`,
      });
    } catch (e) {
      this.toast(
        `Custom indicator ${file} failed to load: ${e.message}`,
        "err",
      );
      return null;
    }
  }

  // ---------- layout ----------
  setLayout(layout, save = true, configs = null) {
    const count = LAYOUTS[layout] || 1;
    this.state.layout = String(layout);
    const grid = $("#grid");
    grid.dataset.count = count;
    const cols = {
      1: "1fr",
      2: layout === "2h" ? "1fr" : "1fr 1fr",
      3: "2fr 1fr",
      4: "1fr 1fr",
      6: "1fr 1fr 1fr",
      8: "1fr 1fr 1fr 1fr",
      16: "repeat(4, 1fr)",
    }[count];
    const rows = {
      1: "1fr",
      2: layout === "2h" ? "1fr 1fr" : "1fr",
      3: "1fr 1fr",
      4: "1fr 1fr",
      6: "1fr 1fr",
      8: "1fr 1fr",
      16: "repeat(4, 1fr)",
    }[count];
    grid.style.gridTemplateColumns = cols;
    grid.style.gridTemplateRows = rows;
    const cfgs = configs || (this.panes.length
      ? this.panes.map((p) => p.cfg)
      : this.state.panes);
    while (this.panes.length > count) this.panes.pop().destroy();
    const tfs = ["1D", "4h", "1h", "15m", "1W", "5m", "30m", "2h"];
    for (let i = 0; i < count; i++) {
      if (this.panes[i]) continue;
      const el = document.createElement("div");
      el.className = "pane";
      grid.appendChild(el);
      const base = cfgs[i] || {
        ...structuredClone(cfgs[0] || {}),
        tf: this.settings.syncTf
          ? cfgs[0]?.tf || this.active?.cfg.tf || "1D"
          : tfs[i % tfs.length],
        indicators: [],
      };
      const pane = new ChartPane(this, el, base);
      this.panes.push(pane);
      pane.load();
    }
    [...grid.children].forEach((el) => {
      if (!this.panes.some((p) => p.el === el)) el.remove();
    });
    if (count === 3) this.panes[0].el.style.gridRow = "span 2";
    else if (this.panes[0]) this.panes[0].el.style.gridRow = "";
    this.setActive(
      this.panes[Math.min(this.state.active ?? 0, count - 1)] || this.panes[0],
    );
    $("#layoutSel").value = this.state.layout;
    if (save) this.persist();
  }

  setActive(pane) {
    if (!pane || this.active === pane) return;
    this.active?.el.classList.remove("active");
    this.active = pane;
    pane.el.classList.add("active");
    this.syncToolbar();
    this.panels?.onActiveChange?.();
  }

  onPaneLoaded(pane) {
    if (pane === this.active) {
      this.syncToolbar();
      this.panels?.onActiveChange?.();
    }
  }

  // ---------- toolbar ----------
  buildToolbar() {
    const tfBox = $("#tfButtons");
    tfBox.innerHTML = TF_QUICK.map(
      (t) => `<button data-tf="${t}">${t}</button>`,
    ).join("");
    tfBox.onclick = (e) => {
      const tf = e.target.dataset.tf;
      if (tf) this.setTf(tf);
    };
    $("#tfCustom").onkeydown = (e) => {
      if (e.key !== "Enter") return;
      const v = e.target.value
        .trim()
        .replace(/^(\d+)d$/i, "$1D")
        .replace(/^(\d+)w$/i, "$1W");
      try {
        parseTf(v);
        this.setTf(v);
        e.target.value = "";
        e.target.blur();
      } catch (err) {
        this.toast(err.message, "err");
      }
    };
    $("#chartType").innerHTML = CHART_TYPES.map(
      ([v, l]) => `<option value="${v}">${l}</option>`,
    ).join("");
    $("#chartType").onchange = (e) => {
      this.active.cfg.type = e.target.value;
      this.active.render(true);
      this.persist();
      this.syncToolbar();
    };
    $("#chartTypeCfg").onclick = () => this.openChartTypeConfig();
    $("#adjSel").onchange = (e) => {
      this.active.cfg.adjust = e.target.value !== "raw";
      this.active.load({ keepView: true });
      this.persist();
    };
    $("#fitBtn").onclick = () => this.active.resetScale();
    $("#saveLayoutBtn").onclick = () => this.saveWorkspacePrompt();
    $("#loadLayoutBtn").onclick = () => this.openWorkspaces();
    $("#symbolBtn").onclick = () => this.openSymbolSearch();
    $("#indicatorsBtn").onclick = () => this.openIndicatorPicker();
    $("#compareBtn").onclick = () =>
      this.openSymbolSearch(
        "",
        (sym) => {
          this.active.cfg.compare.push(sym);
          this.persist();
          this.active.load({ keepView: true });
        },
        "Compare with…",
      );
    $("#layoutSel").onchange = (e) => this.setLayout(e.target.value);
    $("#syncSymbol").checked = !!this.settings.syncSymbol;
    $("#syncSymbol").onchange = (e) => {
      this.settings.syncSymbol = e.target.checked;
      this.persist();
    };
    $("#syncTf").checked = !!this.settings.syncTf;
    $("#syncTf").onchange = (e) => {
      this.settings.syncTf = e.target.checked;
      this.persist();
    };
    $("#replayBtn").onclick = () => {
      if (this.active.replay) return this.active.stopReplay();
      this.setTool("replay-pick");
      this.toast("Click the bar you want replay to start from.");
    };
    $("#alertBtn").onclick = () => this.panels.openAlertDialog();
    $("#logBtn").onclick = () => {
      this.active.cfg.log = !this.active.cfg.log;
      this.active.render(false);
      this.syncToolbar();
      this.persist();
    };
    $("#snapBtn").onclick = () =>
      this.active
        .screenshot()
        .toBlob((b) =>
          download(
            `${ticker(this.active.cfg.symbol)}-${this.active.cfg.tf}.png`,
            b,
          ),
        );
    $("#csvBtn").onclick = () => this.exportCsv();
    $("#themeBtn").onclick = () => {
      this.settings.theme = this.settings.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = this.settings.theme;
      this.panes.forEach((p) => p.applyTheme());
      this.panels.onTheme?.();
      this.persist();
    };
    $("#settingsBtn").onclick = () => this.openSettings();
  }

  syncToolbar() {
    const p = this.active;
    if (!p) return;
    $("#symbolLabel").textContent = ticker(p.cfg.symbol);
    $("#symbolBtn").title =
      `${p.cfg.symbol} — change symbol (or just start typing)`;
    document
      .querySelectorAll("#tfButtons button")
      .forEach((b) => b.classList.toggle("active", b.dataset.tf === p.cfg.tf));
    $("#tfCustom").placeholder = TF_QUICK.includes(p.cfg.tf) ? "7m" : p.cfg.tf;
    $("#tfCustom").classList.toggle("on", !TF_QUICK.includes(p.cfg.tf));
    $("#chartType").value = p.cfg.type;
    $("#adjSel").value = p.cfg.adjust === false ? "raw" : "adj";
    $("#logBtn").classList.toggle("on", !!p.cfg.log);
    $("#replayBtn").classList.toggle("on", !!p.replay);
    const cfgTypes = ["renko", "linebreak", "range", "kagi", "pnf"];
    $("#chartTypeCfg").style.display = cfgTypes.includes(p.cfg.type)
      ? "inline-flex"
      : "none";
  }

  setTf(tf) {
    const targets = this.settings.syncTf ? this.panes : [this.active];
    for (const p of targets) {
      p.cfg.tf = tf;
      p.load();
    }
    this.syncToolbar();
    this.persist();
  }

  setSymbol(sym, pane = this.active) {
    const targets = this.settings.syncSymbol ? this.panes : [pane];
    for (const p of targets) {
      p.cfg.symbol = sym;
      p.cfg.compare = p.cfg.compare.filter((s) => s !== sym);
      p.load();
    }
    this.syncToolbar();
    this.persist();
  }

  buildDrawbar() {
    const bar = $("#drawbar");
    bar.innerHTML =
      TOOLS.map(
        (t, i) =>
          `${i === 1 ? "<hr>" : ""}<button data-tool="${t.id}" title="${t.label}"><svg viewBox="0 0 24 24">${t.icon}</svg></button>`,
      ).join("") +
      '<hr><button data-act="alert" title="Alert when price crosses the selected line"><svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20h4"/></svg></button>' +
      '<button data-act="delete" title="Delete selected drawing (Delete key)"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>' +
      '<button data-act="clear" title="Remove all drawings on this symbol"><svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5L5 19"/></svg></button>';
    bar.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.tool)
        this.setTool(this.tool === b.dataset.tool ? "cursor" : b.dataset.tool);
      if (b.dataset.act === "alert") this.alertOnSelectedDrawing();
      if (b.dataset.act === "delete" && !this.active.deleteSelectedDrawing())
        this.toast("Click a drawing first to select it.");
      if (
        b.dataset.act === "clear" &&
        confirm(`Remove every drawing on ${ticker(this.active.cfg.symbol)}?`)
      )
        this.active.clearDrawings();
    };
    this.setTool("cursor");
  }

  setTool(tool) {
    this.tool = tool;
    document
      .querySelectorAll("#drawbar [data-tool]")
      .forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    for (const p of this.panes) p.setInteractive(tool === "cursor");
    document.body.style.cursor = tool === "cursor" ? "" : "crosshair";
  }

  // ---------- modals ----------
  modal(title, bodyHtml, { foot = "", wide = false, onClose = null } = {}) {
    const card = $("#modalCard");
    this._modalOnClose = onClose;
    card.style.width = wide ? "min(780px, 96vw)" : "";
    card.innerHTML = `<div class="modal-head"><span>${esc(title)}</span><button data-close title="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div><div class="modal-body">${bodyHtml}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ""}`;
    $("#modal").classList.remove("hidden");
    card.querySelector("[data-close]").onclick = () => this.closeModal();
    $("#modal").onmousedown = (e) => {
      if (e.target.id === "modal") this.closeModal();
    };
    return card;
  }
  closeModal() {
    const onClose = this._modalOnClose;
    this._modalOnClose = null;
    $("#modal").classList.add("hidden");
    $("#modalCard").innerHTML = "";
    onClose?.();
  }

  openSymbolSearch(initial = "", onPick = null, title = "Symbol search") {
    const card = this.modal(
      title,
      `<input class="search-in" id="symQ" placeholder="BTC, AAPL, EURUSD, ^FTSE, VOD.L…" autocomplete="off" value="${esc(initial)}"><div class="list" id="symList"></div><div class="hint-text" style="margin-top:8px">Crypto: Binance (falls back to Coinbase and Kraken). US stocks and ETFs: Nasdaq. Forex: Kraken. Global indices, futures and non-US stocks use Yahoo symbols (YAHOO:^FTSE, YAHOO:GC=F) when Yahoo is reachable.</div>`,
    );
    const q = card.querySelector("#symQ"),
      list = card.querySelector("#symList");
    let sel = 0,
      results = [],
      timer;
    const pick = (sym) => {
      this.closeModal();
      if (onPick) onPick(sym);
      else this.setSymbol(sym);
    };
    const draw = () => {
      list.innerHTML =
        results
          .map(
            (r, i) =>
              `<div class="item ${i === sel ? "sel" : ""}" data-i="${i}"><span><b>${esc(ticker(r.symbol))}</b> <span class="muted">${esc(r.name || "")}</span></span><span class="meta">${esc(r.type || "")} · ${esc(r.exchange || "")}</span></div>`,
          )
          .join("") ||
        (q.value.trim()
          ? `<div class="item" data-raw="1"><span>Open <b>${esc(q.value.trim().toUpperCase())}</b></span><span class="meta">press Enter</span></div>`
          : "");
    };
    const run = async () => {
      const v = q.value.trim();
      if (!v) {
        results = [];
        draw();
        return;
      }
      try {
        results = await api.search(v);
      } catch {
        results = [];
      }
      if (q.value.trim() === v) {
        sel = 0;
        draw();
      }
    };
    q.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(run, 180);
    };
    q.onkeydown = (e) => {
      if (e.key === "ArrowDown") {
        sel = Math.min(sel + 1, results.length - 1);
        draw();
        e.preventDefault();
      }
      if (e.key === "ArrowUp") {
        sel = Math.max(sel - 1, 0);
        draw();
        e.preventDefault();
      }
      if (e.key === "Enter") pick(results[sel]?.symbol || q.value.trim());
    };
    list.onclick = (e) => {
      const it = e.target.closest(".item");
      if (!it) return;
      pick(
        it.dataset.raw ? q.value.trim() : results[Number(it.dataset.i)].symbol,
      );
    };
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
    if (initial) run();
  }

  openIndicatorPicker() {
    const card = this.modal(
      "Indicators",
      `<input class="search-in" id="indQ" placeholder="Search ${INDICATORS.length} indicators…" autocomplete="off"><div class="list" id="indList"></div>`,
      {
        foot: '<span class="hint-text" style="margin-right:auto">No limit per chart. Write your own in the Indicator editor tab.</span><button class="btn" data-new>New custom indicator</button>',
      },
    );
    const q = card.querySelector("#indQ"),
      list = card.querySelector("#indList");
    const draw = () => {
      const term = q.value.trim().toLowerCase();
      const groups = {};
      for (const d of INDICATORS) {
        if (
          term &&
          !`${d.name} ${d.id} ${d.group}`.toLowerCase().includes(term)
        )
          continue;
        (groups[d.group || "Other"] ||= []).push(d);
      }
      list.innerHTML = Object.entries(groups)
        .sort(([g1], [g2]) => (g2 === "Quant (bonus)") - (g1 === "Quant (bonus)"))
        .map(
          ([g, ds]) =>
            `<div class="group ${g === "Quant (bonus)" ? "gold-text" : ""}">${esc(g)}</div>${ds.map((d) => `<div class="item" data-id="${esc(d.id)}"><span>${esc(d.name)}</span><span class="meta">${d.overlay ? "on price" : "own pane"}</span></div>`).join("")}`,
        )
        .join("");
    };
    q.oninput = draw;
    list.onclick = (e) => {
      const it = e.target.closest("[data-id]");
      if (!it) return;
      const uid = this.active.addIndicator(it.dataset.id);
      const anchor = (BY_ID[it.dataset.id].inputs || []).find((i) => i.type === "time");
      if (anchor) {
        this.closeModal();
        this.pickAnchor(this.active, uid, anchor.key);
      } else this.toast(`Added ${BY_ID[it.dataset.id].name}`);
    };
    card.querySelector("[data-new]").onclick = () => {
      this.closeModal();
      this.panels.showBottom("editor");
    };
    draw();
    q.focus();
  }

  /** Wait for a click on the chart and anchor indicator `uid` there (Anchored VWAP). Escape keeps the current anchor. */
  pickAnchor(pane, uid, key) {
    this.pendingAnchor = { pane, uid, key };
    this.setTool("anchor-pick");
    this.toast("Click the bar to anchor it to.");
  }

  openIndicatorSettings(pane, ind) {
    const def = BY_ID[ind.id];
    const fields = (def.inputs || [])
      .map((i) => {
        const v = ind.params?.[i.key] ?? i.default;
        if (i.type === "source") {
          // Indicators on indicators: any output of another indicator on this chart can be the source.
          const others = pane.cfg.indicators
            .filter((x) => x.uid !== ind.uid && !String(x.params?.source || "").includes(ind.uid) && BY_ID[x.id]?.outputs.length)
            .flatMap((x) => BY_ID[x.id].outputs.map((o) => [`ind:${x.uid}:${o.key}`, `${(/\(([^)]+)\)$/.exec(BY_ID[x.id].name)?.[1].split(" / ")[0] || BY_ID[x.id].name)} ${pane.indicatorParamsLabel(x)}: ${o.label}`]));
          const price = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4"].map((s) => `<option ${s === v ? "selected" : ""}>${s}</option>`).join("");
          const inds = others.map(([val, label]) => `<option value="${esc(val)}" ${val === v ? "selected" : ""}>${esc(label)}</option>`).join("");
          return `<label class="field">${esc(i.label)}<select data-k="${i.key}"><optgroup label="Price">${price}</optgroup>${inds ? `<optgroup label="Another indicator">${inds}</optgroup>` : ""}</select></label>`;
        }
        if (i.type === "select")
          return `<label class="field">${esc(i.label)}<select data-k="${i.key}">${i.options.map((s) => `<option ${s === v ? "selected" : ""}>${s}</option>`).join("")}</select></label>`;
        if (i.type === "time") {
          const local = v ? new Date((v - new Date(v * 1000).getTimezoneOffset() * 60) * 1000).toISOString().slice(0, 16) : "";
          return `<label class="field">${esc(i.label)}<input data-k="${i.key}" data-type="time" type="datetime-local" value="${local}"><button class="btn small" type="button" data-pick="${i.key}">Pick on chart</button></label>`;
        }
        return `<label class="field">${esc(i.label)}<input data-k="${i.key}" data-type="${i.type}" type="number" step="${i.type === "int" ? 1 : "any"}" value="${v}"></label>`;
      })
      .join("");
    const LINE_STYLES = [
      [0, "Solid"],
      [1, "Dotted"],
      [2, "Dashed"],
      [3, "Large dashes"],
      [4, "Sparse dots"],
    ];
    const stylesOf = (key) => ind.styles?.[key] || {};
    const stylesPane = (pane.indPane?.[ind.uid] ?? 0) > 0;
    // Style tab: one row per plot with its own visibility, colour, line style and width.
    const plotRows = def.outputs
      .map((o) => {
        const st = stylesOf(o.key);
        const vis = st.visible !== false;
        const controls =
          o.kind === "histogram"
            ? ""
            : `<select data-ls="${o.key}" title="Line style">${LINE_STYLES.map(([v, l]) => `<option value="${v}" ${(st.lineStyle ?? 0) === v ? "selected" : ""}>${l}</option>`).join("")}</select><select data-lw="${o.key}" title="Line width">${[1, 2, 3, 4].map((w) => `<option value="${w}" ${(st.lineWidth ?? o.lineWidth ?? 1) === w ? "selected" : ""}>${w}px</option>`).join("")}</select>`;
        return `<div class="plot-row"><input type="checkbox" data-vis="${o.key}" ${vis ? "checked" : ""} title="Show this plot"><span class="plot-name">${esc(o.label)}</span><input data-c="${o.key}" type="color" value="${(ind.colors?.[o.key] || o.color || "#2962ff").slice(0, 7)}" title="Colour">${controls}</div>`;
      })
      .join("");
    // Visibility tab: where each plot's value is reported.
    const visibilityRows = def.outputs
      .map((o) => {
        const st = stylesOf(o.key);
        return `<div class="plot-row"><span class="plot-name">${esc(o.label)}</span><label class="axis-label"><input type="checkbox" data-axis="${o.key}" ${(st.axisLabel ?? stylesPane) ? "checked" : ""}> Price scale</label><label class="axis-label"><input type="checkbox" data-stat="${o.key}" ${st.statusLine !== false ? "checked" : ""}> Status line</label></div>`;
      })
      .join("");
    const zoneRow = (z = {}) => {
      const outs = def.outputs;
      const opts = (sel) =>
        outs
          .map(
            (o) =>
              `<option value="${esc(o.key)}" ${o.key === sel ? "selected" : ""}>${esc(o.label)}</option>`,
          )
          .join("");
      const from = z.from || outs[0]?.key;
      const to = z.to || outs[1]?.key || outs[0]?.key;
      const op = Math.round(
        (Number.isFinite(z.opacity) ? z.opacity : 0.18) * 100,
      );
      const first = (z.color || "#2962ff").slice(0, 7);
      // Keep the second colour even while "Two colours" is off, otherwise switching it back on
      // would silently restart from the first colour. A second colour that is identical to the
      // first (zones saved by the old dialog could end up like that) is useless, so show — and
      // later save — a colour that actually differs.
      const stored = (z.color2 || "").slice(0, 7);
      const second =
        stored && stored.toLowerCase() !== first.toLowerCase()
          ? stored
          : contrastingColor(first);
      const two = z.split ?? !!z.color2;
      return `<div class="zone-row"><label class="field">Fill from<select data-zfrom>${opts(from)}</select></label><label class="field">to<select data-zto>${opts(to)}</select></label><label class="field">First colour<input data-zcolor type="color" value="${first}"></label><label class="field">Second colour<input data-zcolor2 type="color" value="${second}" title="Used when the second line is above the first"></label><label class="field">Opacity<input data-zop type="range" min="0" max="100" step="1" value="${op}"><span class="zone-op">${op}%</span></label><div class="zone-actions"><label class="axis-label"><input data-zsplit type="checkbox" ${two ? "checked" : ""}> Two colours</label><button class="btn small" type="button" data-zswap title="Swap the two colours">Swap colours</button><button class="btn small danger" type="button" data-zdel title="Remove this zone">Remove</button></div></div>`;
    };
    const zoneSection =
      def.outputs.length >= 2
        ? `<h4>Zones between lines</h4><div id="zoneRows">${(ind.zones || []).map(zoneRow).join("")}</div><button class="btn small" type="button" data-addzone>Add zone</button><p class="hint-text">Fill the area between two outputs of this indicator. Tick “Two colours” to switch the fill colour depending on which line is above; use “Swap colours” when the two lines never cross and you want the other colour. Opacity 0% is invisible, 100% is solid.</p>`
        : "";
    const savedDefault = this.state.indicatorDefaults?.[ind.id];
    // Snapshot so closing the dialog without Apply can put the chart back as it was.
    const original = structuredClone({
      params: ind.params,
      colors: ind.colors,
      styles: ind.styles,
      zones: ind.zones,
      tf: ind.tf,
    });
    let committed = false;
    let previewTimer = null;
    const card = this.modal(
      def.name,
      `<div class="ind-tabs" role="tablist"><button type="button" class="active" data-itab="inputs">Inputs</button><button type="button" data-itab="style">Style</button><button type="button" data-itab="visibility">Visibility</button></div><div class="ind-panel" data-ipanel="inputs"><div class="form-grid">${fields || '<span class="hint-text">No inputs.</span>'}<label class="field">Timeframe<select data-tf>${["", "5m", "15m", "1h", "4h", "1D", "1W", "1M"].map((t) => `<option value="${t}" ${(ind.tf || "") === t ? "selected" : ""}>${t || `Same as chart (${pane.cfg.tf})`}</option>`).join("")}</select></label></div><p class="hint-text">A higher timeframe shows its value once each of its bars has closed, so history never peeks ahead.</p></div><div class="ind-panel hidden" data-ipanel="style"><h4>Plots</h4>${plotRows}${zoneSection}</div><div class="ind-panel hidden" data-ipanel="visibility"><h4>Output values</h4>${visibilityRows}<p class="hint-text">“Price scale” shows the last value next to the axis. “Status line” shows live values in the chart legend.</p></div>`,
      {
        foot: `<span class="def-note" id="defNote">${savedDefault ? 'Custom default saved <button type="button" class="link def-forget" data-forget>Forget</button>' : "Using factory defaults"}</span><button class="btn" data-savedefault title="Use these settings whenever this indicator is added">Save as default</button><button class="btn" data-reset title="${savedDefault ? "Reset to your saved default" : "Reset to factory defaults"}">Reset</button><button class="btn primary" data-ok>Apply</button>`,
        onClose: () => {
          clearTimeout(previewTimer);
          if (committed) return;
          ind.params = original.params;
          ind.colors = original.colors;
          ind.styles = original.styles;
          ind.zones = original.zones;
          ind.tf = original.tf;
          pane.render(false);
          this.persist();
        },
      },
    );
    card.querySelectorAll("[data-itab]").forEach((b) => {
      b.onclick = () => {
        card.querySelectorAll("[data-itab]").forEach((x) => x.classList.toggle("active", x === b));
        card.querySelectorAll("[data-ipanel]").forEach((p) => p.classList.toggle("hidden", p.dataset.ipanel !== b.dataset.itab));
      };
    });
    const zonesBox = card.querySelector("#zoneRows");
    if (zonesBox) {
      const syncOpacity = () =>
        card.querySelectorAll("[data-zop]").forEach((r) => {
          r.nextElementSibling.textContent = `${r.value}%`;
        });
      card.querySelector("[data-addzone]").onclick = () => {
        zonesBox.insertAdjacentHTML("beforeend", zoneRow({}));
        syncOpacity();
      };
      zonesBox.addEventListener("click", (e) => {
        if (e.target.closest("[data-zdel]")) {
          e.target.closest(".zone-row").remove();
          return;
        }
        if (e.target.closest("[data-zswap]")) {
          const row = e.target.closest(".zone-row");
          const c1 = row.querySelector("[data-zcolor]");
          const c2 = row.querySelector("[data-zcolor2]");
          [c1.value, c2.value] = [c2.value, c1.value];
          c1.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      zonesBox.addEventListener("change", (e) => {
        // Turning two colours on while both swatches hold the same colour looks like nothing
        // happened, so seed a clearly different second colour.
        if (e.target.matches("[data-zsplit]") && e.target.checked) {
          const row = e.target.closest(".zone-row");
          const c1 = row.querySelector("[data-zcolor]");
          const c2 = row.querySelector("[data-zcolor2]");
          if (c1.value.toLowerCase() === c2.value.toLowerCase()) {
            c2.value = contrastingColor(c1.value);
            c2.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      });
      zonesBox.addEventListener("input", (e) => {
        if (e.target.matches("[data-zop]"))
          e.target.nextElementSibling.textContent = `${e.target.value}%`;
      });
    }
    const readForm = () => {
      const params = {};
      card.querySelectorAll("[data-k]").forEach((el) => {
        params[el.dataset.k] =
          el.dataset.type === "time"
            ? el.value
              ? Math.floor(new Date(el.value).getTime() / 1000)
              : 0
            : el.dataset.type
              ? Number(el.value)
              : el.value;
      });
      const colors = {};
      card.querySelectorAll("[data-c]").forEach((el) => {
        colors[el.dataset.c] = el.value;
      });
      const styles = {};
      const styleOf = (key) => (styles[key] ||= {});
      card.querySelectorAll("[data-vis]").forEach((el) => (styleOf(el.dataset.vis).visible = el.checked));
      card.querySelectorAll("[data-ls]").forEach((el) => (styleOf(el.dataset.ls).lineStyle = Number(el.value)));
      card.querySelectorAll("[data-lw]").forEach((el) => (styleOf(el.dataset.lw).lineWidth = Number(el.value)));
      card.querySelectorAll("[data-axis]").forEach((el) => (styleOf(el.dataset.axis).axisLabel = el.checked));
      card.querySelectorAll("[data-stat]").forEach((el) => (styleOf(el.dataset.stat).statusLine = el.checked));
      const zones = [...card.querySelectorAll(".zone-row")]
        .map((row) => ({
          from: row.querySelector("[data-zfrom]").value,
          to: row.querySelector("[data-zto]").value,
          color: row.querySelector("[data-zcolor]").value,
          // Always keep the second colour so unticking "Two colours" does not lose it.
          color2: row.querySelector("[data-zcolor2]").value,
          split: row.querySelector("[data-zsplit]").checked,
          opacity: Math.max(
            0,
            Math.min(1, Number(row.querySelector("[data-zop]").value) / 100),
          ),
        }))
        .filter((z) => z.from && z.to && z.from !== z.to);
      return { params, colors, styles, zones };
    };
    // Live preview: edits reach the chart immediately, and closing without Apply restores the
    // snapshot taken when the dialog opened. Debounced so dragging a slider does not rebuild the
    // panes on every pixel.
    const applyDraft = () => {
      const d = readForm();
      ind.params = d.params;
      ind.colors = d.colors;
      ind.styles = d.styles;
      ind.zones = d.zones;
      ind.tf = card.querySelector("[data-tf]")?.value || undefined;
    };
    const schedulePreview = () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        // A blur/change can arrive just after the dialog closed, when the fields are gone.
        if (committed || $("#modal").classList.contains("hidden")) return;
        applyDraft();
        pane.render(false);
        this.persist();
      }, 250);
    };
    card.addEventListener("input", schedulePreview);
    card.addEventListener("change", schedulePreview);
    const bindForget = () => {
      const b = card.querySelector("[data-forget]");
      if (!b) return;
      b.onclick = () => {
        delete this.state.indicatorDefaults[ind.id];
        this.persist();
        card.querySelector("#defNote").textContent = "Using factory defaults";
        card.querySelector("[data-reset]").title = "Reset to factory defaults";
        this.toast(`Default forgotten for ${esc(def.name)}`);
      };
    };
    bindForget();
    card.querySelector("[data-savedefault]").onclick = () => {
      this.state.indicatorDefaults[ind.id] = readForm();
      this.persist();
      const note = card.querySelector("#defNote");
      note.innerHTML =
        'Custom default saved <button type="button" class="link def-forget" data-forget>Forget</button>';
      bindForget();
      card.querySelector("[data-reset]").title = "Reset to your saved default";
      this.toast(`Default saved for ${esc(def.name)}`);
    };
    card.querySelector("[data-ok]").onclick = () => {
      clearTimeout(previewTimer);
      applyDraft();
      committed = true;
      this.closeModal();
      pane.render(false);
      this.persist();
    };
    card.querySelectorAll("[data-pick]").forEach((b) => {
      b.onclick = () => {
        clearTimeout(previewTimer);
        applyDraft();
        committed = true;
        this.closeModal();
        this.pickAnchor(pane, ind.uid, b.dataset.pick);
        this.persist();
      };
    });
    card.querySelector("[data-reset]").onclick = () => {
      // "Reset" means the user's saved default when there is one, factory settings otherwise.
      clearTimeout(previewTimer);
      committed = true;
      const d = structuredClone(this.state.indicatorDefaults?.[ind.id] || {});
      ind.params = d.params || {};
      ind.colors = d.colors || {};
      ind.styles = d.styles || {};
      ind.zones = d.zones || [];
      ind.tf = undefined;
      this.closeModal();
      pane.render(false);
      this.persist();
    };
  }

  openSettings() {
    const s = this.settings;
    const srcOpts = (current, choices) =>
      choices
        .map(([v, label]) => `<option value="${v}" ${current === v ? "selected" : ""}>${label}</option>`)
        .join("");
    const card = this.modal(
      "Settings",
      `<div class="form-grid">
      <label class="field">Bars to load per chart<input id="sBars" type="number" min="200" max="20000" step="100" value="${s.bars}"></label>
      <label class="field">Time axis<select id="sUtc"><option value="0" ${!s.utc ? "selected" : ""}>My local time</option><option value="1" ${s.utc ? "selected" : ""}>UTC</option></select></label>
      <label class="field">Volume on the price chart<select id="sVol"><option value="1" ${s.volume ? "selected" : ""}>Show</option><option value="0" ${!s.volume ? "selected" : ""}>Hide</option></select></label>
      <label class="field">Daily charts use<select id="sDaily">${srcOpts(s.dailySrc || "auto", [["auto", "Auto (recommended)"], ["nasdaq", "Nasdaq"], ["yahoo", "Yahoo Finance"]])}</select></label>
      <label class="field">Intraday charts use<select id="sIntraday">${srcOpts(s.intradaySrc || "auto", [["auto", "Auto (recommended)"], ["yahoo", "Yahoo Finance"], ["nasdaq", "Nasdaq (today only)"], ["ibkr", "TWS (needs TWS running)"]])}</select></label>
      <label class="field">After placing a drawing<select id="sStay"><option value="0" ${!s.stayInDrawMode ? "selected" : ""}>Back to cursor</option><option value="1" ${s.stayInDrawMode ? "selected" : ""}>Keep the tool</option></select></label>
      <label class="field">Crosshair across charts<select id="sSync"><option value="0" ${!s.syncCrosshair ? "selected" : ""}>Independent</option><option value="1" ${s.syncCrosshair ? "selected" : ""}>Synced</option></select></label>
    </div><p class="hint-text">Everything you save lives in the <code>data</code> folder next to the app, on your machine.</p>`,
      { foot: '<button class="btn primary" data-ok>Save</button>' },
    );
    card.querySelector("[data-ok]").onclick = () => {
      Object.assign(s, {
        bars: Math.max(200, Math.min(20000, Number($("#sBars").value) || 3000)),
        utc: $("#sUtc").value === "1",
        volume: $("#sVol").value === "1",
        dailySrc: $("#sDaily").value,
        intradaySrc: $("#sIntraday").value,
        stayInDrawMode: $("#sStay").value === "1",
        syncCrosshair: $("#sSync").value === "1",
      });
      this.closeModal();
      this.persist();
      this.panes.forEach((p) => p.load({ keepView: true }));
    };
  }

  // Chart-type specific parameters (Renko box size, Kagi reversal, Line Break lines, etc.)
  saveWorkspacePrompt() {
    const name = prompt(
      "Name this layout:",
      this.workspaceName(),
    );
    if (!name) return;
    const all = this.state.workspaces;
    const at = all.findIndex((w) => w.name === name);
    const ws = {
      id: at >= 0 ? all[at].id : newUid(),
      name,
      layout: this.state.layout,
      panes: structuredClone(this.panes.map((p) => p.cfg)),
      at: Date.now(),
    };
    if (at >= 0) all[at] = ws;
    else all.push(ws);
    this.state.activeWorkspace = ws.id;
    this.persist();
    this.toast(at >= 0 ? `Updated “${esc(name)}”.` : `Saved “${esc(name)}”.`);
  }

  openChartTypeConfig() {
    const p = this.active;
    const t = p.cfg.type;
    const c = p.cfg.chartTypeCfg || {};
    const label = {
      renko: "Renko box size (0 = auto ATR)",
      linebreak: "Line Break — number of lines",
      range: "Range Bars — tick range (0 = auto ATR)",
      kagi: "Kagi reversal (0 = auto ATR)",
      pnf: "Point & Figure",
    }[t];
    if (!label) return;
    const fields = {
      renko: `<label class="field">${label}<input id="ctBox" type="number" step="any" min="0" value="${c.boxSize || 0}"></label>`,
      linebreak: `<label class="field">${label}<input id="ctLines" type="number" min="1" max="10" value="${c.lines || 3}"></label>`,
      range: `<label class="field">${label}<input id="ctRange" type="number" step="any" min="0" value="${c.range || 0}"></label>`,
      kagi: `<label class="field">${label}<input id="ctReversal" type="number" step="any" min="0" value="${c.reversal || 0}"></label>`,
      pnf: `<label class="field">Box size (0 = auto ATR)<input id="ctPnfBox" type="number" step="any" min="0" value="${c.boxSize || 0}"></label>
            <label class="field">Reversal boxes<input id="ctPnfRev" type="number" min="1" max="10" value="${c.reversal || 3}"></label>`,
    }[t];
    const card = this.modal(
      `${CHART_TYPES.find(([v]) => v === t)?.[1] || t} settings`,
      `<div class="form-grid">${fields}</div><p class="hint-text">Leave at 0 for ATR-based auto-sizing. Values are per chart and saved with the layout.</p>`,
      { foot: '<button class="btn primary" data-ok>Apply</button>' },
    );
    card.querySelector("[data-ok]").onclick = () => {
      const cfg = { ...c };
      if (t === "renko") cfg.boxSize = Number($("#ctBox").value) || 0;
      else if (t === "linebreak") cfg.lines = Math.max(1, Math.min(10, Number($("#ctLines").value) || 3));
      else if (t === "range") cfg.range = Number($("#ctRange").value) || 0;
      else if (t === "kagi") cfg.reversal = Number($("#ctReversal").value) || 0;
      else if (t === "pnf") {
        cfg.boxSize = Number($("#ctPnfBox").value) || 0;
        cfg.reversal = Math.max(1, Math.min(10, Number($("#ctPnfRev").value) || 3));
      }
      p.cfg.chartTypeCfg = cfg;
      this.closeModal();
      p.render(true);
      this.persist();
      this.toast(`${CHART_TYPES.find(([v]) => v === t)?.[1] || t} updated.`);
    };
  }

  // ---------- saved layouts (grid + every chart's symbol and config) ----------
  currentWorkspace() {
    return (this.state.workspaces || []).find(
      (w) => w.id === this.state.activeWorkspace,
    ) || null;
  }

  workspaceName() {
    const loaded = this.currentWorkspace();
    if (loaded) return loaded.name;
    const syms = [...new Set(this.panes.map((p) => ticker(p.cfg.symbol)))];
    if (!syms.length) return "Layout";
    return syms.length > 3
      ? `${syms.slice(0, 3).join(", ")} +${syms.length - 3}`
      : syms.join(", ");
  }

  openWorkspaces() {
    const list = this.state.workspaces || [];
    const rows = list.length
      ? list
          .map(
            (w, i) =>
              `<div class="item" data-ws="${i}"><span><b>${esc(w.name)}</b>${w.id === this.state.activeWorkspace ? ' <span class="muted">(current)</span>' : ""}<br><span class="muted">${esc((w.panes || []).map((p) => ticker(p.symbol)).join(" · "))}</span></span><span class="meta">${(w.panes || []).length} chart${(w.panes || []).length === 1 ? "" : "s"} <button class="btn small" data-act="load">Load</button> <button class="btn small danger" data-act="del">Delete</button></span></div>`,
          )
          .join("")
      : '<div class="hint-text">No saved layouts yet.</div>';
    const card = this.modal(
      "Layouts",
      `<div class="list">${rows}</div><div class="form-grid" style="margin-top:12px"><label class="field">Name this layout<input id="wsName" value="${esc(this.workspaceName())}" autocomplete="off"></label></div><p class="hint-text">Saving under the current name updates that layout. A saved layout keeps the grid, and every chart's symbol, timeframe, chart type, indicators, compare list, adjusted/raw choice and indicator zones.</p>`,
      { foot: '<button class="btn primary" data-save>Save current layout</button>' },
    );
    card.querySelectorAll("[data-ws]").forEach((row) => {
      row.onclick = (e) => {
        const w = list[Number(row.dataset.ws)];
        if (!w) return;
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (act === "del") {
          this.state.workspaces = list.filter((x) => x !== w);
          if (this.state.activeWorkspace === w.id)
            this.state.activeWorkspace = null;
          this.persist();
          this.openWorkspaces();
          this.toast(`Deleted “${esc(w.name)}”.`);
          return;
        }
        if (act === "load") this.applyWorkspace(w);
      };
    });
    card.querySelector("[data-save]").onclick = () => {
      const typed = card.querySelector("#wsName").value.trim();
      const name = typed || this.workspaceName();
      const all = this.state.workspaces;
      const at = all.findIndex((w) => w.name === name);
      const ws = {
        id: at >= 0 ? all[at].id : newUid(),
        name,
        layout: this.state.layout,
        panes: structuredClone(this.panes.map((p) => p.cfg)),
        at: Date.now(),
      };
      if (at >= 0) all[at] = ws;
      else all.push(ws);
      this.state.activeWorkspace = ws.id;
      this.persist();
      this.closeModal();
      this.toast(
        at >= 0 ? `Updated “${esc(name)}”.` : `Saved “${esc(name)}”.`,
      );
    };
  }

  applyWorkspace(ws) {
    const panes = structuredClone(ws.panes || []);
    const layout = String(ws.layout || "1");
    const count = LAYOUTS[layout] || 1;
    this.state.panes = panes;
    this.state.layout = layout;
    this.state.active = 0;
    this.state.activeWorkspace = ws.id || null;
    // Reuse the charts already on screen (new ones are created by setLayout); tearing every
    // chart down and building the grid again makes the chart engine resize disposed canvases.
    for (let i = 0; i < Math.min(this.panes.length, count); i++)
      this.panes[i].applyConfig(panes[i] || {});
    this.setLayout(layout, false, panes);
    this.persist();
    this.closeModal();
    this.toast(`Loaded “${esc(ws.name)}”.`);
  }

  syncCrosshair(src, p) {
    const utc = src.timeOfLogical(p.logical);
    for (const pane of this.panes) {
      if (pane === src || !pane.shown.length) continue;
      const l = pane.logicalOf(utc);
      const i = Math.max(0, Math.min(pane.shown.length - 1, Math.round(l)));
      const b = pane.shown[i];
      if (b) pane.chart.setCrosshairPosition(b.close, pane.times[i], pane.main);
    }
  }

  exportCsv() {
    const p = this.active;
    const extra = {};
    for (const ind of p.cfg.indicators) {
      const def = BY_ID[ind.id];
      const res = p.indResults[ind.uid] || {};
      for (const o of def?.outputs || [])
        if (Array.isArray(res[o.key])) extra[`${ind.id}_${o.key}`] = res[o.key];
    }
    download(`${ticker(p.cfg.symbol)}-${p.cfg.tf}.csv`, toCsv(p.shown, extra));
  }

  // ---------- keys ----------
  bindKeys() {
    document.addEventListener("keydown", (e) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(
        document.activeElement?.tagName,
      );
      if (e.key === "Escape") {
        if (!$("#modal").classList.contains("hidden")) return this.closeModal();
        if (this.tool !== "cursor") return this.setTool("cursor");
        if (this.active?.drawings.selected) {
          this.active.drawings.selected = null;
          this.active.drawings.update();
        }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        this.active?.deleteSelectedDrawing()
      ) {
        e.preventDefault();
        return;
      }
      if (!$("#modal").classList.contains("hidden")) return;
      if (/^[a-z0-9^]$/i.test(e.key)) {
        e.preventDefault();
        this.openSymbolSearch(e.key.toUpperCase());
      }
    });
  }

  // A drawn line as an alert condition: trend lines and rays are checked at the line's price on
  // each bar, on the server, so they fire with this tab closed.
  lineOperandFor(d) {
    const [a, b] = d.points;
    const line = (extend, label) => ({ kind: "line", label, line: { t1: a.time, p1: a.price, t2: b.time, p2: b.price, extend } });
    switch (d.type) {
      case "hline": return { kind: "value", v: Number(a.price.toPrecision(8)) };
      case "hray": return { kind: "line", label: "Horizontal ray", line: { t1: a.time, p1: a.price, t2: a.time + 1, p2: a.price, extend: "right" } };
      case "trend": return line("none", "Trend line (between its two points)");
      case "ray": return line("right", "Ray");
      case "extended": return line("both", "Extended line");
      case "channel": return line("none", "Channel's first line");
      default: return null;
    }
  }

  alertOnSelectedDrawing() {
    const d = this.active?.drawings.selected;
    if (!d) return this.toast("Click a line on the chart first to select it.");
    const right = this.lineOperandFor(d);
    if (!right) return this.toast("Alerts work on trend lines, rays, extended and horizontal lines.");
    this.panels.openAlertDialog({ rules: [{ left: { kind: "price", field: "close" }, op: "crosses", right }] });
  }

  // ---------- replay across charts ----------
  syncReplayFrom(pane, bar) {
    if (!bar) return;
    const end = bar.time + parseTf(pane.cfg.tf).seconds;
    for (const p of this.panes) if (p !== pane && p.bars.length && !(p.replay && !p.replay.follower)) p.replayTo(end);
  }
  onReplayStart(pane) {
    if (this.settings.syncReplay && !pane.replay?.follower) this.syncReplayFrom(pane, pane.bars[pane.replay.index]);
    this.syncToolbar();
    this.panels?.onReplayChange?.();
  }
  onReplayBar(pane, bar) {
    if (this.settings.syncReplay && !pane.replay?.follower) this.syncReplayFrom(pane, bar);
    this.panels?.onReplayBar?.(pane, bar);
  }
  onReplayStop(pane) {
    for (const p of this.panes) if (p !== pane && p.replay?.follower) p.stopReplay();
    this.syncToolbar();
    this.panels?.onReplayChange?.();
  }

  // ---------- prices, alerts, status ----------
  onPrice(symbol, price) {
    this.prices[symbol] = price;
    for (const fn of this.priceListeners) fn(symbol, price);
  }

  listenAlerts() {
    const es = new EventSource("/api/events");
    es.addEventListener("alert", (m) => {
      const e = JSON.parse(m.data);
      this.toast(`<b>Alert</b><br>${esc(e.text)}`, "alert", 12000);
      this.beep();
      if ("Notification" in window && Notification.permission === "granted")
        new Notification("Quant Terminal alert", { body: e.text });
      this.panels?.onAlertFired?.(e);
    });
  }

  beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(),
        g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.value = 0.08;
      o.start();
      o.stop(ctx.currentTime + 0.25);
    } catch {
      /* no audio */
    }
  }

  async checkHealth() {
    try {
      const h = await api.get("/api/health");
      const failing = Object.entries(h.providers || {})
        .filter(([, v]) => !v.ok)
        .map(([k]) => k);
      this.setStatus(
        failing.length ? "warn" : "ok",
        failing.length
          ? `Some sources are failing (${failing.join(", ")}); fallbacks are in use.`
          : "All data sources responding",
      );
    } catch {
      this.setStatus(
        "bad",
        "The local server is not responding. Is it still running?",
      );
    }
  }
  setStatus(level, title) {
    const el = $("#status");
    el.className = `status ${level}`;
    if (title) el.title = title;
  }

  toast(html, kind = "", ms = 3500) {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.innerHTML = html;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
}

const app = new App();
window.app = app;
app.init().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="toast err" style="position:fixed;left:20px;bottom:20px">Startup failed: ${esc(e.message)}</div>`,
  );
});
