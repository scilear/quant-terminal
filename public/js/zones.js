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

/**
 * A colour that reads as clearly different from `color`: the RGB complement, which turns blue into
 * amber and green into pink. Grey has no useful complement, so fall back to the down red there.
 */
export function contrastingColor(color) {
  let hex = String(color || "").trim().replace(/^#/, "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return "#f23645";
  const n = parseInt(hex, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const cr = 255 - r;
  const cg = 255 - g;
  const cb = 255 - b;
  // Nearly grey input: a complement is nearly grey too, so pick a definite colour instead.
  if (Math.abs(cr - r) + Math.abs(cg - g) + Math.abs(cb - b) < 120) return "#f23645";
  return `#${[cr, cg, cb].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export class ZoneFill {
  constructor(pane, opts) {
    this.pane = pane;
    this.seriesA = opts.seriesA;
    this.seriesB = opts.seriesB;
    this.dataA = opts.dataA;
    this.dataB = opts.dataB;
    this.fill = withAlpha(opts.color, opts.opacity);
    // Optional second colour: used when line B is above line A, like TradingView's two-tone fill.
    this.fill2 = opts.color2 ? withAlpha(opts.color2, opts.opacity) : null;
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

  _band(ctx, run, fill) {
    if (run.length < 2) return;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(run[0].x, run[0].ya);
    for (let k = 1; k < run.length; k++) ctx.lineTo(run[k].x, run[k].ya);
    for (let k = run.length - 1; k >= 0; k--) ctx.lineTo(run[k].x, run[k].yb);
    ctx.closePath();
    ctx.fill();
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

    const pts = [];
    for (let i = from; i <= to; i++) {
      const va = this.dataA[i],
        vb = this.dataB[i];
      if (!Number.isFinite(va) || !Number.isFinite(vb)) {
        pts.push(null);
        continue;
      }
      const x = ts.logicalToCoordinate(i);
      const ya = this.seriesA.priceToCoordinate(va);
      const yb = this.seriesB.priceToCoordinate(vb);
      if (x == null || ya == null || yb == null) {
        pts.push(null);
        continue;
      }
      pts.push({ x, ya, yb, above: va >= vb });
    }

    if (!this.fill2) {
      // Single colour: one polygon per contiguous run of valid values.
      let run = [];
      for (const p of pts) {
        if (p) run.push(p);
        else {
          this._band(ctx, run, this.fill);
          run = [];
        }
      }
      this._band(ctx, run, this.fill);
      return;
    }

    // Two colours: split each run exactly where the lines cross, so the band changes colour at
    // the crossing point instead of switching on a whole bar.
    let run = [];
    let side = null;
    let prev = null;
    const flush = () => {
      this._band(ctx, run, side ? this.fill : this.fill2);
      run = [];
    };
    for (const p of pts) {
      if (!p) {
        flush();
        side = null;
        prev = null;
        continue;
      }
      if (side === null) {
        side = p.above;
        run = [p];
        prev = p;
        continue;
      }
      if (p.above !== side) {
        const dPrev = Math.abs(prev.ya - prev.yb);
        const dCur = Math.abs(p.ya - p.yb);
        const t = dPrev + dCur ? dPrev / (dPrev + dCur) : 0;
        const cross = {
          x: prev.x + (p.x - prev.x) * t,
          ya: prev.ya + (p.ya - prev.ya) * t,
          yb: prev.yb + (p.yb - prev.yb) * t,
          above: side,
        };
        run.push(cross);
        flush();
        side = p.above;
        run = [cross, p];
      } else run.push(p);
      prev = p;
    }
    flush();
  }
}
