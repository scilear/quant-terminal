export default {
  name: 'Ehlers Instantaneous Trend',
  overlay: true,
  inputs: [
    { key: 'source', label: 'Source', type: 'source', default: 'hl2' },
    { key: 'alpha', label: 'Alpha', type: 'float', default: 0.07 },
    { key: 'hide_ribbon', label: 'Hide ribbon?', type: 'select', options: ['No', 'Yes'], default: 'No' },
    { key: 'scl_len', label: 'Short Cycle Length?', type: 'int', default: 10, min: 1 },
    { key: 'mcl_len', label: 'Medium Cycle Length?', type: 'int', default: 30, min: 1 },
    { key: 'scm', label: 'Short Cycle Multiplier?', type: 'float', default: 1.0 },
    { key: 'mcm', label: 'Medium Cycle Multiplier?', type: 'float', default: 3.0 },
  ],
  outputs: [
    { key: 'it', label: 'Trend', kind: 'line', color: '#ff0000' },
    { key: 'lag', label: 'Trigger', kind: 'line', color: '#0000ff' },
    { key: 'sl_atr', label: 'SL ATR', kind: 'line', color: '#ff0000' },
    { key: 'sl_std', label: 'SL STD', kind: 'line', color: '#ff9800' },
    { key: 'sl_atr_dn', label: 'SL ATR-', kind: 'line', color: '#ff0000' },
    { key: 'sl_std_dn', label: 'SL STD-', kind: 'line', color: '#ff9800' },
    { key: 'sma10', label: 'SMA10', kind: 'line', color: '#ff0000' },
    { key: 'bol_up', label: 'BOL+', kind: 'line', color: '#2962ff' },
    { key: 'bol', label: 'BOL', kind: 'line', color: '#2962ff' },
    { key: 'bol_dn', label: 'BOL-', kind: 'line', color: '#2962ff' },
    { key: 'sct', label: 'ShortCycleTop', kind: 'line', color: '#b0b0b0' },
    { key: 'scb', label: 'ShortCycleBottom', kind: 'line', color: '#b0b0b0' },
    { key: 'scm_mid', label: 'ShortCycleMedian', kind: 'line', color: '#808080' },
    { key: 'mct', label: 'MediumCycleTop', kind: 'line', color: '#b0b0b0' },
    { key: 'mcb', label: 'MediumCycleBottom', kind: 'line', color: '#b0b0b0' },
    { key: 'mcm_mid', label: 'MediumCycleMedian', kind: 'line', color: '#000000' },
  ],
  // Port of "Ehlers Instantaneous Trend [LazyBear]" (old study() script).
  // Two notes: fills and barcolors have no equivalent in custom scripts,
  // so trend fills / red-lime bars are left out. All lines match Pine math.
  calc(bars, p, ta) {
    const src = ta.source(bars, p.source || 'hl2');
    const high = ta.source(bars, 'high');
    const low = ta.source(bars, 'low');
    const close = ta.source(bars, 'close');
    const n = bars.length;
    const a = p.alpha;
    // --- Ehlers instantaneous trend (recursive, same formula as Pine) ---
    const it = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const s0 = src[i];
      const s1 = i > 0 ? src[i - 1] : NaN;
      const s2 = i > 1 ? src[i - 2] : NaN;
      const seed =
        Number.isFinite(s0) && Number.isFinite(s1) && Number.isFinite(s2)
          ? (s0 + 2 * s1 + s2) / 4
          : NaN;
      const d1 = i > 0 && Number.isFinite(it[i - 1]) ? it[i - 1] : seed;
      const d2 = i > 1 && Number.isFinite(it[i - 2]) ? it[i - 2] : seed;
      it[i] =
        (a - (a * a) / 4.0) * s0 +
        0.5 * a * a * s1 -
        (a - 0.75 * a * a) * s2 +
        2 * (1 - a) * d1 -
        (1 - a) * (1 - a) * d2;
    }
    const lag = it.map((v, i) =>
      Number.isFinite(v) ? 2 * v - (i >= 2 && Number.isFinite(it[i - 2]) ? it[i - 2] : 0) : NaN,
    );
    const hide = p.hide_ribbon === 'Yes';
    const itLine = it.map((v, i) => (hide || i < 2 ? NaN : v));
    const lagLine = lag.map((v, i) => (hide || i < 2 ? NaN : v));
    // --- Stop lines ---
    const atr10 = ta.atr(bars, 10);
    const sdH10 = ta.stdev(high, 10);
    const atrBase = high.map((h, i) =>
      i > 0 && Number.isFinite(h) && Number.isFinite(atr10[i - 1])
        ? bars[i - 1].high - 2 * atr10[i - 1]
        : NaN,
    );
    const stdBase = high.map((h, i) =>
      i > 0 && Number.isFinite(sdH10[i - 1]) ? bars[i - 1].high - 2 * sdH10[i - 1] : NaN,
    );
    const atrBaseDn = low.map((l, i) =>
      i > 0 && Number.isFinite(atr10[i - 1]) ? bars[i - 1].low + 2 * atr10[i - 1] : NaN,
    );
    const stdBaseDn = low.map((l, i) =>
      i > 0 && Number.isFinite(sdH10[i - 1]) ? bars[i - 1].low + 2 * sdH10[i - 1] : NaN,
    );
    const sl_atr = ta.highest(atrBase, 10);
    const sl_std = ta.highest(stdBase, 10);
    const sl_atr_dn = ta.lowest(atrBaseDn, 10);
    const sl_std_dn = ta.lowest(stdBaseDn, 10);
    // --- SMA10 + Bollinger variants (kept as written, incl. lowest/highest) ---
    const sma10 = ta.compute('sma', bars, { source: 'close', length: 10 }).value;
    const bbm = ta.sma(close, 20);
    const stdb = ta.stdev(close, 20);
    const bbmUp = bbm.map((v, i) =>
      Number.isFinite(v) && Number.isFinite(stdb[i]) ? v + 2 * stdb[i] : NaN,
    );
    const bbmDn = bbm.map((v, i) =>
      Number.isFinite(v) && Number.isFinite(stdb[i]) ? v - 2 * stdb[i] : NaN,
    );
    const bol_up = ta.lowest(bbmUp, 20);
    const bol = bbm;
    const bol_dn = ta.highest(bbmDn, 20);
    // --- Hurst bands ---
    const scl = Math.max(1, Math.round(p.scl_len / 2));
    const mcl = Math.max(1, Math.round(p.mcl_len / 2));
    const ma_scl = ta.rma(src, scl);
    const ma_mcl = ta.rma(src, mcl);
    const atrS = ta.atr(bars, scl);
    const atrM = ta.atr(bars, mcl);
    const scm_off = atrS.map((v) => (Number.isFinite(v) ? p.scm * v : NaN));
    const mcm_off = atrM.map((v) => (Number.isFinite(v) ? p.mcm * v : NaN));
    const sk = Math.max(0, Math.round(scl / 2));
    const mk = Math.max(0, Math.round(mcl / 2));
    const ref = (arr, i, k, fb) => {
      if (i - k >= 0 && Number.isFinite(arr[i - k])) return arr[i - k];
      return fb;
    };
    const sct = src.map((s, i) => {
      const base = ref(ma_scl, i, sk, s);
      return Number.isFinite(base) && Number.isFinite(scm_off[i]) ? base + scm_off[i] : NaN;
    });
    const scb = src.map((s, i) => {
      const base = ref(ma_scl, i, sk, s);
      return Number.isFinite(base) && Number.isFinite(scm_off[i]) ? base - scm_off[i] : NaN;
    });
    const mct = src.map((s, i) => {
      const base = ref(ma_mcl, i, mk, s);
      return Number.isFinite(base) && Number.isFinite(mcm_off[i]) ? base + mcm_off[i] : NaN;
    });
    const mcb = src.map((s, i) => {
      const base = ref(ma_mcl, i, mk, s);
      return Number.isFinite(base) && Number.isFinite(mcm_off[i]) ? base - mcm_off[i] : NaN;
    });
    const scm_mid = sct.map((v, i) =>
      Number.isFinite(v) && Number.isFinite(scb[i]) ? (v + scb[i]) / 2 : NaN,
    );
    const mcm_mid = mct.map((v, i) =>
      Number.isFinite(v) && Number.isFinite(mcb[i]) ? (v + mcb[i]) / 2 : NaN,
    );
    return {
      it: itLine,
      lag: lagLine,
      sl_atr,
      sl_std,
      sl_atr_dn,
      sl_std_dn,
      sma10,
      bol_up,
      bol,
      bol_dn,
      sct,
      scb,
      scm_mid,
      mct,
      mcb,
      mcm_mid,
    };
  },
};
