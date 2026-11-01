export default {
  name: 'PFE MACD Combo',
  overlay: false, // own pane: oscillator lines, not on the price chart
  inputs: [
    { key: 'length', label: 'PFE Length', type: 'int', default: 9, min: 1 },
    { key: 'length_ema', label: 'PFE EMA Length', type: 'int', default: 5, min: 1 },
    { key: 'pfe_factor', label: 'PFE Factor', type: 'float', default: 1.0 },
    { key: 'source', label: 'MACD Source', type: 'source', default: 'close' },
    { key: 'fast', label: 'MACD Fast', type: 'int', default: 13, min: 1 },
    { key: 'slow', label: 'MACD Slow', type: 'int', default: 25, min: 1 },
    { key: 'sig_len', label: 'Signal Length', type: 'int', default: 7, min: 1 },
    { key: 'show_macd', label: 'Show MACD & Signal?', type: 'select', options: ['Yes', 'No'], default: 'Yes' },
    { key: 'show_hist', label: 'Show Histogram?', type: 'select', options: ['Yes', 'No'], default: 'Yes' },
    { key: 'show_dots', label: 'Show Cross Dots?', type: 'select', options: ['Yes', 'No'], default: 'Yes' },
  ],
  outputs: [
    { key: 'pfe', label: 'PFE', kind: 'line', color: '#2962ff' },
    { key: 'top', label: 'TopBand', kind: 'line', color: '#089981' },
    { key: 'low', label: 'LowBand', kind: 'line', color: '#f23645' },
    { key: 'macd', label: 'MACD', kind: 'line', color: '#00c853' },
    { key: 'signal', label: 'Signal Line', kind: 'line', color: '#ffab00' },
    { key: 'hist', label: 'Histogram', kind: 'histogram', color: '#808080' },
    { key: 'zero', label: '0 Line', kind: 'line', color: '#ffffff' },
  ],
  // Port of HPotter's PFE plus the MACD block pasted below it.
  // Two notes: the "different timeframe" box needs other timeframes and
  // custom scripts only see the open chart, so this runs on the current
  // chart. Per-bar MACD/histogram colours become fixed colours here.
  calc(bars, p, ta) {
    const n = bars.length;
    const close = ta.source(bars, 'close');
    const src = ta.source(bars, p.source || 'close');
    // --- PFE ---
    const diffL = close.map((c, i) =>
      Number.isFinite(c) && i >= p.length && Number.isFinite(close[i - p.length])
        ? c - close[i - p.length]
        : NaN,
    );
    const pfeRaw = diffL.map((d) => (Number.isFinite(d) ? Math.sqrt(d * d + 100) : NaN));
    const step = close.map((c, i) => {
      if (!Number.isFinite(c) || i < 1 || !Number.isFinite(close[i - 1])) return NaN;
      const d = c - close[i - 1];
      return Math.sqrt(d * d + 1);
    });
    const c2c = ta.sum(step, p.length);
    const frac = diffL.map((d, i) => {
      if (!Number.isFinite(d) || !Number.isFinite(pfeRaw[i]) || !Number.isFinite(c2c[i]) || c2c[i] === 0)
        return NaN;
      const v = (pfeRaw[i] / c2c[i]) * 100;
      return Math.round(d > 0 ? v : -v);
    });
    const xEMA = ta.ema(frac, p.length_ema);
    const pfe = xEMA.map((v) => (Number.isFinite(v) ? v * p.pfe_factor : NaN));
    const top = new Array(n).fill(50 * p.pfe_factor);
    const low = new Array(n).fill(-50 * p.pfe_factor);
    // --- MACD on the current chart (Use Current Resolution path) ---
    const fastMA = ta.ema(src, p.fast);
    const slowMA = ta.ema(src, p.slow);
    const macd = fastMA.map((v, i) =>
      Number.isFinite(v) && Number.isFinite(slowMA[i]) ? v - slowMA[i] : NaN,
    );
    const signal = ta.sma(macd, p.sig_len);
    const hist = macd.map((v, i) =>
      Number.isFinite(v) && Number.isFinite(signal[i]) ? v - signal[i] : NaN,
    );
    const hi = ta.highest(macd, 100);
    const lo = ta.lowest(macd, 100);
    const scaling = macd.map((_, i) => {
      const a = Number.isFinite(hi[i]) ? hi[i] : NaN;
      const b = Number.isFinite(lo[i]) ? lo[i] : NaN;
      if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
      const m = Math.max(a, -b);
      return m !== 0 ? 100 / m : NaN;
    });
    const showM = p.show_macd === 'Yes';
    const showH = p.show_hist === 'Yes';
    const macdOut = macd.map((v, i) =>
      showM && Number.isFinite(v) && Number.isFinite(scaling[i]) ? v * scaling[i] : NaN,
    );
    const sigOut = signal.map((v, i) =>
      showM && Number.isFinite(v) && Number.isFinite(scaling[i]) ? v * scaling[i] : NaN,
    );
    const histOut = hist.map((v, i) =>
      showH && Number.isFinite(v) && Number.isFinite(scaling[i]) ? v * scaling[i] : NaN,
    );
    const zero = new Array(n).fill(0);
    // cross dots -> markers on the signal line
    const markers = [];
    if (p.show_dots === 'Yes') {
      const up = ta.crossover(macd, signal);
      const dn = ta.crossunder(macd, signal);
      for (let i = 0; i < n; i++) {
        if ((up[i] || dn[i]) && Number.isFinite(sigOut[i]))
          markers.push({
            time: bars[i].time,
            position: up[i] ? 'belowBar' : 'aboveBar',
            shape: up[i] ? 'arrowUp' : 'arrowDown',
            color: up[i] ? '#00c853' : '#f23645',
            text: '●',
          });
      }
    }
    return { pfe, top, low, macd: macdOut, signal: sigOut, hist: histOut, zero, markers };
  },
};
