// Sidebar width bands, shared by Work and Usage.
import assert from "node:assert/strict";
import { test } from "node:test";

const { band, RAIL, resize } = await import("../src/sidebar.js");

const BANDS = [
  ["rail", RAIL],
  ["short", 300],
];

test("a width's band is the first it is narrower than", () => {
  assert.equal(band(RAIL - 1, BANDS), "rail");
  assert.equal(band(RAIL, BANDS), "short");
  assert.equal(band(299, BANDS), "short");
  assert.equal(band(300, BANDS), "full");
  assert.equal(band(null, BANDS), "full");
});

test("a resize re-renders only when the band changes", () => {
  const view = { width: null };
  const key = (w) => band(w, BANDS);
  assert.equal(resize(view, 400, key), false);
  assert.equal(resize(view, 350, key), false);
  assert.equal(view.width, 350);
  assert.equal(resize(view, 200, key), true);
  assert.equal(resize(view, 210, key), false);
  assert.equal(resize(view, 100, key), true);
});
