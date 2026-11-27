// Refresh timings for work.report (src/refreshes.js): the report's numbers over
// the recent window, and that the window is bounded.
import assert from "node:assert/strict";
import { test } from "node:test";

const { RefreshStats, WINDOW } = await import("../src/refreshes.js");

test("an empty report has no timings", () => {
  assert.deepEqual(new RefreshStats().report(), {
    count: 0,
    window: 0,
    meanMs: null,
    p95Ms: null,
    maxMs: null,
    spawnsPerRefresh: {},
    rateLimitedRefreshes: 0,
  });
});

test("the 95th percentile is the value 95% of the refreshes are at or under", () => {
  const stats = new RefreshStats();
  // 1..100 ms: the 95th of 100 values is the 95th smallest.
  for (let ms = 1; ms <= 100; ms++)
    stats.add({ ms, spawns: { git: 2 }, rateLimited: 0 });
  const r = stats.report();
  assert.equal(r.count, 100);
  assert.equal(r.p95Ms, 95);
  assert.equal(r.maxMs, 100);
  assert.equal(r.meanMs, 50.5);
});

test("the window keeps the last WINDOW refreshes; the count keeps all", () => {
  const stats = new RefreshStats();
  // Old, slow refreshes first; they must drop out of the timings.
  for (let i = 0; i < WINDOW; i++)
    stats.add({ ms: 1000, spawns: { git: 1 }, rateLimited: 0 });
  for (let i = 0; i < WINDOW; i++)
    stats.add({ ms: 10, spawns: { git: 3, gh: 1 }, rateLimited: i % 2 });
  const r = stats.report();
  assert.equal(r.count, 2 * WINDOW);
  assert.equal(r.window, WINDOW);
  assert.equal(r.maxMs, 10);
  assert.equal(r.p95Ms, 10);
  assert.deepEqual(r.spawnsPerRefresh, { git: 3, gh: 1 });
  assert.equal(r.rateLimitedRefreshes, WINDOW / 2);
});
