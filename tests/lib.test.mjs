// Small shared helpers.
import assert from "node:assert/strict";
import { test } from "node:test";

const { cycle } = await import("../src/lib.js");

test("cycle: moves through n items and wraps both ways", () => {
  assert.equal(cycle(3, 0, 1), 1);
  assert.equal(cycle(3, 2, 1), 0);
  assert.equal(cycle(3, 0, -1), 2);
  assert.equal(cycle(1, 0, 1), 0);
});
