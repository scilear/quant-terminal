export default {
  name: 'Q-Trend',
  overlay: true,
  inputs: [
    { key: 'source', label: 'Source', type: 'source', default: 'close' },
    { key: 'period', label: 'Trend period', type: 'int', default: 200, min: 1 },
    { key: 'atr_len', label: 'ATR Period', type: 'int', default: 14, min: 1 },
    { key: 'mult', label: 'ATR Multiplier', type: 'float', default: 1.0 },
    { key: 'mode', label: 'Signal mode', type: 'select', options: ['Type A', 'Type B'], default: 'Type A' },
    { key: 'smooth', label: 'Smooth source with EMA?', type: 'select', options: ['No', 'Yes'], default: 'No' },
    { key: 'ema_len', label: 'EMA Smoother period', type: 'int', default: 3, min: 1 },
    { key: 'show_tl', label: 'Show trend line?', type: 'select', options: ['Yes', 'No'], default: 'Yes' },
    { key: 'view', label: 'Signals to show', type: 'select', options: ['All', 'Buy/Sell', 'Strong', 'None'], default: 'All' },
    { key: 'shape', label: "Signal's shape", type: 'select', options: ['Labels', 'Arrows'], default: 'Labels' },
  ],
  outputs: [{ key: 'trend', label: 'Trend line', kind: 'line', color: '#26a69a' }],
  // Port of "Q-Trend" (@tarasenko_). One note: Pine's barcolor has no
  // equivalent in custom scripts, so bars stay normal here. BUY/SELL/STRONG
  // come as markers, trend line is single-colour (recolour it if you like).
  calc(bars, p, ta) {
    const raw = ta.source(bars, p.source || 'close');
    const src = p.smooth === 'Yes' ? ta.ema(raw, p.ema_len) : raw;
    const open = ta.source(bars, 'open');
    const n = bars.length;
    const h = ta.highest(src, p.period);
    const l = ta.lowest(src, p.period);
    const atrRaw = ta.atr(bars, p.atr_len);
    const isB = p.mode === 'Type B';
    const m = new Array(n).fill(NaN);
    const ls = new Array(n).fill(null);
    const chUp = new Array(n).fill(false);
    const chDn = new Array(n).fill(false);
    const strongB = new Array(n).fill(false);
    const strongS = new Array(n).fill(false);
    const sb = new Array(n).fill(false);
    const ss = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      const mid = Number.isFinite(h[i]) && Number.isFinite(l[i]) ? (h[i] + l[i]) / 2 : NaN;
      const d = Number.isFinite(h[i]) && Number.isFinite(l[i]) ? h[i] - l[i] : NaN;
      if (Number.isFinite(open[i]) && Number.isFinite(l[i]) && Number.isFinite(d))
        sb[i] = open[i] < l[i] + d / 8 && open[i] >= l[i];
      if (Number.isFinite(open[i]) && Number.isFinite(h[i]) && Number.isFinite(d))
        ss[i] = open[i] > h[i] - d / 8 && open[i] <= h[i];
      for (let k = 0; k <= 4; k++) {
        if (i - k >= 0 && sb[i - k]) strongB[i] = true;
        if (i - k >= 0 && ss[i - k]) strongS[i] = true;
      }
      let mPrev = NaN;
      if (i === 0) mPrev = mid;
      else mPrev = Number.isFinite(m[i - 1]) ? m[i - 1] : mid;
      // first p bars: flat mid line, no signals (matches bar_index > p guard)
      if (i <= p.period) {
        m[i] = mid;
        ls[i] = i > 0 ? ls[i - 1] : null;
        continue;
      }
      const eps = i > 0 && Number.isFinite(atrRaw[i - 1]) ? p.mult * atrRaw[i - 1] : NaN;
      const cur = src[i];
      const prev = i > 0 ? src[i - 1] : NaN;
      const upNow = Number.isFinite(mPrev) && Number.isFinite(eps) ? mPrev + eps : NaN;
      const dnNow = Number.isFinite(mPrev) && Number.isFinite(eps) ? mPrev - eps : NaN;
      const upPrev =
        i > 0 && Number.isFinite(m[i - 1]) && Number.isFinite(atrRaw[i - 1]) && Number.isFinite(eps)
          ? m[i - 1] + (i > 1 && Number.isFinite(atrRaw[i - 2]) ? p.mult * atrRaw[i - 2] : NaN)
          : NaN;
      // Simpler and closer to Pine: compare against previous band built from mPrev and previous eps.
      const prevEps = i > 1 && Number.isFinite(atrRaw[i - 2]) ? p.mult * atrRaw[i - 2] : NaN;
      const pUp = Number.isFinite(mPrev) && Number.isFinite(prevEps) && i > 0 && Number.isFinite(m[i - 1])
        ? m[i - 1] + prevEps
        : NaN;
      const pDn = Number.isFinite(mPrev) && Number.isFinite(prevEps) && i > 0 && Number.isFinite(m[i - 1])
        ? m[i - 1] - prevEps
        : NaN;
      void upPrev;
      const overUp = Number.isFinite(prev) && Number.isFinite(pUp) && Number.isFinite(cur) && Number.isFinite(upNow)
        ? prev <= pUp && cur > upNow
        : false;
      const underUp = Number.isFinite(prev) && Number.isFinite(pUp) && Number.isFinite(cur) && Number.isFinite(upNow)
        ? prev >= pUp && cur < upNow
        : false;
      const overDn = Number.isFinite(prev) && Number.isFinite(pDn) && Number.isFinite(cur) && Number.isFinite(dnNow)
        ? prev <= pDn && cur > dnNow
        : false;
      const underDn = Number.isFinite(prev) && Number.isFinite(pDn) && Number.isFinite(cur) && Number.isFinite(dnNow)
        ? prev >= pDn && cur < dnNow
        : false;
      const crossUpAny = overUp || underUp;
      const crossDnAny = overDn || underDn;
      const aboveUp = Number.isFinite(cur) && Number.isFinite(upNow) ? cur > upNow : false;
      const belowDn = Number.isFinite(cur) && Number.isFinite(dnNow) ? cur < dnNow : false;
      const up = (isB ? crossUpAny : overUp) || aboveUp;
      const dn = (isB ? crossDnAny : underDn) || belowDn;
      chUp[i] = up;
      chDn[i] = dn;
      if (up && !dn) m[i] = upNow;
      else if (dn && !up) m[i] = dnNow;
      else if (up && dn) m[i] = upNow; // Pine prefers up when both fire
      else m[i] = Number.isFinite(mPrev) ? mPrev : mid;
      const prevLs = i > 0 ? ls[i - 1] : null;
      ls[i] = up ? 'B' : dn ? 'S' : prevLs;
    }
    const showTl = p.show_tl !== 'No';
    const trend = m.map((v, i) => (showTl && i > p.period ? v : NaN));
    const markers = [];
    if (p.view !== 'None') {
      const wantRegular = p.view === 'All' || p.view === 'Buy/Sell';
      const wantStrong = p.view === 'All' || p.view === 'Strong';
      const labels = p.shape === 'Labels';
      for (let i = 1; i < n; i++) {
        if (!chUp[i] && !chDn[i]) continue;
        const prevLs = ls[i - 1];
        const t = bars[i].time;
        if (chUp[i] && prevLs !== 'B') {
          if (strongB[i] && wantStrong)
            markers.push({ time: t, position: 'belowBar', shape: 'arrowUp', color: '#089981', text: labels ? 'STRONG' : '▲' });
          else if (!strongB[i] && wantRegular)
            markers.push({ time: t, position: 'belowBar', shape: 'arrowUp', color: '#089981', text: labels ? 'BUY' : '▲' });
        }
        if (chDn[i] && prevLs !== 'S') {
          if (strongS[i] && wantStrong)
            markers.push({ time: t, position: 'aboveBar', shape: 'arrowDown', color: '#f23645', text: labels ? 'STRONG' : '▼' });
          else if (!strongS[i] && wantRegular)
            markers.push({ time: t, position: 'aboveBar', shape: 'arrowDown', color: '#f23645', text: labels ? 'SELL' : '▼' });
        }
      }
    }
    return { trend, markers };
  },
};
