import test from "node:test";
import assert from "node:assert/strict";
import { withAlpha, ZoneFill } from "../public/js/zones.js";

test("withAlpha turns a hex colour into rgba with the requested opacity", () => {
  assert.equal(withAlpha("#2962ff", 0.2), "rgba(41,98,255,0.2)");
  assert.equal(withAlpha("#fff", 0.5), "rgba(255,255,255,0.5)");
});

test("withAlpha clamps opacity and survives bad input", () => {
  assert.equal(withAlpha("#089981", 2), "rgba(8,153,129,1)");
  assert.equal(withAlpha("#089981", -1), "rgba(8,153,129,0)");
  assert.equal(withAlpha("#089981", NaN), "rgba(8,153,129,0.18)");
  assert.equal(withAlpha("not-a-colour", 0.3), "rgba(41,98,255,0.3)");
});

test("ZoneFill draws one band for each contiguous run of values", () => {
  const pane = {
    times: [1, 2, 3, 4, 5, 6],
    chart: {
      timeScale: () => ({
        getVisibleLogicalRange: () => ({ from: 0, to: 5 }),
        logicalToCoordinate: (i) => i * 10,
      }),
    },
  };
  const seriesA = { priceToCoordinate: (v) => 100 - v };
  const seriesB = { priceToCoordinate: (v) => 120 - v };
  const ctx = {
    fillStyle: "",
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {
      this.fills++;
    },
    fills: 0,
  };
  const zone = new ZoneFill(pane, {
    seriesA,
    seriesB,
    dataA: [1, 2, NaN, 4, 5, NaN],
    dataB: [2, 3, NaN, 5, 6, NaN],
    color: "#2962ff",
    opacity: 0.2,
  });
  zone.draw(ctx);
  assert.equal(ctx.fills, 2);
  assert.equal(ctx.fillStyle, "rgba(41,98,255,0.2)");
});
