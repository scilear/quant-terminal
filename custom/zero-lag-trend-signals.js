export default {
  name: 'Zero Lag Trend Signals',
  overlay: true, // true = drawn on the price chart
  inputs: [
    { key: 'length', label: 'Length', type: 'int', default: 70, min: 2 },
    { key: 'mult', label: 'Band Multiplier', type: 'float', default: 1.2 },
  ],
  outputs: [
    { key: 'zlema', label: 'Zero Lag Basis', kind: 'line', color: '#2962ff' },
    { key: 'upper', label: 'Upper Band', kind: 'line', color: '#ff1100' },
    { key: 'lower', label: 'Lower Band', kind: 'line', color: '#00ffbb' },
  ],
  // Single-timeframe port of "Zero Lag Trend Signals (MTF) [AlgoAlpha]".
  // MTF table (5/15/60/240/1D) needs other timeframes, custom scripts only
  // see the current chart, so it is left out. Core trend + entries match Pine.
  calc(bars, p, ta) {
    const close = ta.source(bars, 'close');
    const n = bars.length;
    const lag = Math.floor((p.length - 1) / 2);
    // zlema = ema(src + (src - src[lag]), length)
    const deLag = close.map((c, i) => {
      if (!Number.isFinite(c)) return NaN;
      const past = i >= lag ? close[i - lag] : NaN;
      if (!Number.isFinite(past)) return NaN;
      return c + (c - past);
    });
    const zlema = ta.ema(deLag, p.length);
    // volatility = highest(atr(length), length*3) * mult
    const atr = ta.atr(bars, p.length);
    const volBase = ta.highest(atr, p.length * 3);
    const volatility = volBase.map((v) => (Number.isFinite(v) ? v * p.mult : NaN));
    const zUp = zlema.map((z, i) =>
      Number.isFinite(z) && Number.isFinite(volatility[i]) ? z + volatility[i] : NaN,
    );
    const zDn = zlema.map((z, i) =>
      Number.isFinite(z) && Number.isFinite(volatility[i]) ? z - volatility[i] : NaN,
    );
    const crossUp = ta.crossover(close, zUp);
    const crossDn = ta.crossunder(close, zDn);
    let trend = 0;
    const trendArr = new Array(n);
    for (let i = 0; i < n; i++) {
      if (crossUp[i]) trend = 1;
      else if (crossDn[i]) trend = -1;
      trendArr[i] = trend;
    }
    // Pine plots upper only when bearish, lower only when bullish
    const upper = zUp.map((v, i) => (trendArr[i] === -1 ? v : NaN));
    const lower = zDn.map((v, i) => (trendArr[i] === 1 ? v : NaN));
    const crossEntryUp = ta.crossover(close, zlema);
    const crossEntryDn = ta.crossunder(close, zlema);
    const markers = [];
    for (let i = 1; i < n; i++) {
      const t = bars[i].time;
      if (trendArr[i] === 1 && trendArr[i - 1] !== 1)
        markers.push({ time: t, position: 'belowBar', shape: 'arrowUp', color: '#00ffbb', text: '▲' });
      else if (trendArr[i] === -1 && trendArr[i - 1] !== -1)
        markers.push({ time: t, position: 'aboveBar', shape: 'arrowDown', color: '#ff1100', text: '▼' });
      if (crossEntryUp[i] && trendArr[i] === 1 && trendArr[i - 1] === 1)
        markers.push({ time: t, position: 'belowBar', shape: 'arrowUp', color: '#00ffbb', text: '▲' });
      if (crossEntryDn[i] && trendArr[i] === -1 && trendArr[i - 1] === -1)
        markers.push({ time: t, position: 'aboveBar', shape: 'arrowDown', color: '#ff1100', text: '▼' });
    }
    return { zlema, upper, lower, markers };
  },
};
