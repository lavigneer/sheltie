// Render timings for work.report (src/renders.js): the report's shape, not
// the timings themselves.
import assert from "node:assert/strict";
import { test } from "node:test";

const { RenderStats, SLOWEST, SLOW_MS } = await import("../src/renders.js");

test("an empty report has no mean", () => {
  assert.deepEqual(new RenderStats().report(), {
    count: 0,
    meanMs: null,
    byTrigger: {},
    last: null,
    slowest: [],
  });
});

test("counts renders, keeps the slowest few with what triggered them", () => {
  const stats = new RenderStats();
  const triggers = ["hover", "scan", "host", "lookup"];
  for (let i = 0; i < 20; i++)
    stats.add({
      ms: i,
      viewMs: i / 2,
      buildMs: i / 2,
      rows: 3,
      trigger: triggers[i % 4],
      at: 1000 + i,
    });
  const r = stats.report();
  assert.equal(r.count, 20);
  assert.equal(typeof r.meanMs, "number");
  assert.deepEqual(r.byTrigger, { hover: 5, scan: 5, host: 5, lookup: 5 });
  assert.equal(r.last.ms, 19);
  assert.equal(r.slowest.length, SLOWEST);
  assert.deepEqual(
    r.slowest.map((s) => s.ms),
    [19, 18, 17, 16, 15],
  );
  for (const s of r.slowest)
    assert.deepEqual(Object.keys(s).sort(), [
      "at",
      "buildMs",
      "ms",
      "rows",
      "trigger",
      "viewMs",
    ]);
});

test("says when a render is slow", () => {
  const stats = new RenderStats();
  const r = { viewMs: 0, buildMs: 0, rows: 0, trigger: "host" };
  assert.equal(stats.add({ ...r, ms: SLOW_MS }), false);
  assert.equal(stats.add({ ...r, ms: SLOW_MS + 1 }), true);
});
