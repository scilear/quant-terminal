// Coloured zones (TradingView's "fill between two lines"): a translucent band drawn between the
// values of two outputs of the same indicator, with its own colour and opacity.

export function withAlpha(color, opacity) {
  const o = Math.max(0, Math.min(1, Number(opacity)));
  const alpha = Number.isFinite(o) ? o : 0.18;
  let hex = String(color || "#2962ff").trim().replace(/^#/, "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return `rgba(41,98,255,${alpha})`;
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export class ZoneFill {
  constructor(pane, opts) {
    this.pane = pane;
    this.seriesA = opts.seriesA;
    this.seriesB = opts.seriesB;
    this.dataA = opts.dataA;
    this.dataB = opts.dataB;
    this.fill = withAlpha(opts.color, opts.opacity);
    this._view = {
      zOrder: () => "bottom",
      renderer: () => ({
        draw: (target) =>
          target.useMediaCoordinateSpace(({ context }) => this.draw(context)),
      }),
    };
  }

  attached({ requestUpdate }) {
    this.requestUpdate = requestUpdate;
  }
  detached() {
    this.requestUpdate = null;
  }
  updateAllViews() {}
  paneViews() {
    return [this._view];
  }

  draw(ctx) {
    const chart = this.pane.chart;
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    const n = Math.min(
      this.dataA.length,
      this.dataB.length,
      this.pane.times.length,
    );
    if (!range || !n) return;
    const from = Math.max(0, Math.floor(range.from));
    const to = Math.min(n - 1, Math.ceil(range.to));
    if (to <= from) return;

    ctx.fillStyle = this.fill;
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        ctx.beginPath();
        ctx.moveTo(run[0].x, run[0].ya);
        for (let k = 1; k < run.length; k++) ctx.lineTo(run[k].x, run[k].ya);
        for (let k = run.length - 1; k >= 0; k--)
          ctx.lineTo(run[k].x, run[k].yb);
        ctx.closePath();
        ctx.fill();
      }
      run = [];
    };
    for (let i = from; i <= to; i++) {
      const va = this.dataA[i],
        vb = this.dataB[i];
      if (!Number.isFinite(va) || !Number.isFinite(vb)) {
        flush();
        continue;
      }
      const x = ts.logicalToCoordinate(i);
      const ya = this.seriesA.priceToCoordinate(va);
      const yb = this.seriesB.priceToCoordinate(vb);
      if (x == null || ya == null || yb == null) {
        flush();
        continue;
      }
      run.push({ x, ya, yb });
    }
    flush();
  }
}
