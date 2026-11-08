// Polling helpers (src/watch.js).
import assert from "node:assert/strict";
import { test } from "node:test";

const { Cache, serial } = await import("../src/watch.js");

test("serial: one run at a time; requests meanwhile run once more, forced if any was", async () => {
  const tasks = [];
  const cx = { spawn: (f) => tasks.push(f(cx)) };
  const runs = [];
  let release;
  const start = serial(async (_cx, force) => {
    runs.push(force);
    if (runs.length === 1) await new Promise((r) => (release = r));
  });
  start(cx);
  start(cx, true);
  start(cx);
  start(cx);
  assert.deepEqual(runs, [false]);
  release();
  while (tasks.length) await tasks.shift();
  assert.deepEqual(runs, [false, true]);
  start(cx);
  while (tasks.length) await tasks.shift();
  assert.deepEqual(runs, [false, true, false]);
});

test("serial: a failing run still lets the queued one run", async () => {
  const tasks = [];
  const cx = { spawn: (f) => tasks.push(f(cx).catch(() => {})) };
  let n = 0;
  let release;
  const start = serial(async () => {
    n++;
    if (n === 1) {
      await new Promise((r) => (release = r));
      throw new Error("boom");
    }
  });
  start(cx);
  start(cx);
  release();
  while (tasks.length) await tasks.shift();
  assert.equal(n, 2);
});

test("Cache.due: missing, forced, failed past retry, or older than maxAge", async () => {
  let t = 0;
  const c = new Cache({ retryMs: 10, now: () => t });
  assert.ok(c.due("a", 100));
  await c.refresh("a", () => "v");
  assert.ok(!c.due("a", 100));
  assert.ok(c.due("a", 100, { force: true }));
  t = 101;
  assert.ok(c.due("a", 100));
  await c.refresh("a", () => {
    throw new Error("down");
  });
  t = 110;
  assert.ok(!c.due("a", 100));
  t = 112;
  assert.ok(c.due("a", 100));
});

test("Cache.refresh: found / none / failed, a failure keeping the last value", async () => {
  let t = 5;
  const c = new Cache({ retryMs: 10, now: () => t });
  assert.deepEqual(await c.refresh("a", async () => ({ n: 1 })), {
    state: "found",
    value: { n: 1 },
    at: 5,
  });
  t = 6;
  const failed = await c.refresh("a", async () => {
    throw new Error("down");
  });
  assert.deepEqual(failed, { state: "failed", value: { n: 1 }, at: 6 });
  assert.equal((await c.refresh("a", () => null)).state, "none");
  assert.deepEqual(
    await c.refresh("b", () => {
      throw new Error("down");
    }),
    { state: "failed", value: null, at: 6 },
  );
  assert.equal(c.get("a").value, null);
});
