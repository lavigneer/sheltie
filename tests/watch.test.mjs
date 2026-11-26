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

test("Cache: the version moves when a lookup changes an entry, not when it confirms it", async () => {
  let t = 0;
  const c = new Cache({ retryMs: 60_000, now: () => t });
  await c.refresh("a", async () => ({ n: 1 }));
  const v = c.version;
  t += 1000;
  await c.refresh("a", async () => ({ n: 1 }));
  assert.equal(c.version, v, "the same value");
  assert.equal(c.get("a").at, 1000, "still marks when it was looked up");
  await c.refresh("a", async () => ({ n: 2 }));
  assert.equal(c.version, v + 1, "a new value");
  await c.refresh("a", async () => {
    throw new Error("down");
  });
  assert.equal(c.version, v + 2, "found -> failed");
  assert.deepEqual(c.get("a").value, { n: 2 }, "a failure keeps the value");
  await c.refresh("b", async () => null);
  assert.equal(c.version, v + 3, "a new entry");
});

test("serial: forcing() while a forced run is running or queued, notifying as it starts and ends", async () => {
  const tasks = [];
  let notified = 0;
  const cx = { spawn: (f) => tasks.push(f(cx)), notify: () => notified++ };
  const releases = [];
  const start = serial(() => new Promise((r) => releases.push(r)));
  start(cx);
  assert.equal(start.forcing(), false);
  start(cx, true); // queued behind the unforced run
  assert.equal(start.forcing(), true);
  assert.equal(notified, 1);
  releases.shift()();
  await tasks.shift();
  assert.equal(start.forcing(), true); // the forced one now runs
  releases.shift()();
  await tasks.shift();
  assert.equal(start.forcing(), false);
  assert.equal(notified, 2);
});

test("serial: a forced run that throws ends forcing(); the next request runs unforced", async () => {
  const tasks = [];
  let notified = 0;
  const cx = {
    spawn: (f) => tasks.push(f(cx).catch(() => {})),
    notify: () => notified++,
  };
  const runs = [];
  const start = serial(async (_cx, force) => {
    runs.push(force);
    if (runs.length === 1) throw new Error("boom");
  });
  start(cx, true);
  assert.equal(start.forcing(), true);
  while (tasks.length) await tasks.shift();
  assert.equal(start.forcing(), false, "state reset after the throw");
  assert.equal(notified, 2, "starts, then ends");
  start(cx);
  while (tasks.length) await tasks.shift();
  assert.deepEqual(runs, [true, false]);
  assert.equal(start.forcing(), false);
});
