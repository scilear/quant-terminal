import test from "node:test";
import assert from "node:assert/strict";
import { withAlpha, contrastingColor, ZoneFill } from "../public/js/zones.js";

test("withAlpha turns a hex colour into rgba with the requested opacity", () => {
  assert.equal(withAlpha("#2962ff", 0.2), "rgba(41,98,255,0.2)");
  assert.equal(withAlpha("#fff", 0.5), "rgba(255,255,255,0.5)");
});

test("contrastingColor returns a visibly different hex colour", () => {
  assert.equal(contrastingColor("#2962ff"), "#d69d00");
  assert.equal(contrastingColor("#089981"), "#f7667e");
  assert.equal(contrastingColor("#fff"), "#000000");
  // Grey has no useful complement, so it falls back to the down red rather than a near-identical grey.
  assert.equal(contrastingColor("#808080"), "#f23645");
  assert.equal(contrastingColor("not-a-colour"), "#f23645");
  assert.equal(contrastingColor(""), "#f23645");
  for (const c of ["#2962ff", "#f23645", "#089981", "#ff9800", "#787b86"]) {
    assert.match(contrastingColor(c), /^#[0-9a-f]{6}$/);
    assert.notEqual(contrastingColor(c).toLowerCase(), c.toLowerCase());
  }
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

test("ZoneFill switches colour where the two lines cross", () => {
  const pane = {
    times: [1, 2, 3],
    chart: {
      timeScale: () => ({
        getVisibleLogicalRange: () => ({ from: 0, to: 2 }),
        logicalToCoordinate: (i) => i * 10,
      }),
    },
  };
  const seriesA = { priceToCoordinate: (v) => 100 - v };
  const seriesB = { priceToCoordinate: (v) => 120 - v };
  const seen = [];
  const ctx = {
    fillStyle: "",
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {
      seen.push(this.fillStyle);
    },
  };
  const zone = new ZoneFill(pane, {
    seriesA,
    seriesB,
    dataA: [1, 3, 1],
    dataB: [2, 1, 2],
    color: "#089981",
    color2: "#f23645",
    opacity: 0.5,
  });
  zone.draw(ctx);
  // B above A, then A above B, then B above A: three bands split at both crossings.
  assert.deepEqual(seen, [
    "rgba(242,54,69,0.5)",
    "rgba(8,153,129,0.5)",
    "rgba(242,54,69,0.5)",
  ]);
});

test("ZoneFill skips a lone value that has no neighbour to fill against", () => {
  const pane = {
    times: [1, 2, 3],
    chart: {
      timeScale: () => ({
        getVisibleLogicalRange: () => ({ from: 0, to: 2 }),
        logicalToCoordinate: (i) => i * 10,
      }),
    },
  };
  let fills = 0;
  const ctx = {
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {
      fills++;
    },
  };
  const zone = new ZoneFill(pane, {
    seriesA: { priceToCoordinate: (v) => 100 - v },
    seriesB: { priceToCoordinate: (v) => 100 - v },
    dataA: [NaN, 1, NaN],
    dataB: [NaN, 2, NaN],
    color: "#2962ff",
    opacity: 0.2,
  });
  zone.draw(ctx);
  assert.equal(fills, 0);
});
