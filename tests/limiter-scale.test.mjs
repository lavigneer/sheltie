// The gh limiter (lib.js `tool`) under a poll storm (#370): many poll timers'
// calls at once through a fake gh with latency, with rate-limit answers
// switched on and off. The limiter's state is per process, so this file has it
// to itself. Date is mocked, so a backoff can be waited out without waiting.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, mock, test } from "node:test";

const { C } = await import("../src/config.js");
const { tool } = await import("../src/lib.js");

const LATENCY_S = 0.05;
const STORM = 60; // calls fired at once, like every poll timer of a big workspace

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sheltie-limiter-"));
const log = path.join(dir, "log");
const limitFlag = path.join(dir, "limited");
const gh = path.join(dir, "gh");
// Logs start and end of each call; answers like GitHub's rate limit while
// the flag file exists.
fs.writeFileSync(
  gh,
  `#!/bin/sh
echo "start $1" >> ${log}
sleep ${LATENCY_S}
echo "end $1" >> ${log}
if [ -e ${limitFlag} ]; then echo "API rate limit exceeded" >&2; exit 1; fi
echo "ok $1"`,
);
fs.chmodSync(gh, 0o755);

const lines = () =>
  fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
    : [];
const started = () => lines().filter((l) => l.startsWith("start"));
const mostAtOnce = () => {
  let running = 0;
  let most = 0;
  for (const l of lines()) {
    running += l.startsWith("start") ? 1 : -1;
    most = Math.max(most, running);
  }
  return most;
};
// The backoff a refused call tells ("retrying in N s").
const waitOf = (/** @type {{ stderr: string }} */ r) =>
  Number(r.stderr.match(/retrying in (\d+) s/)?.[1] ?? Number.NaN);
const storm = (/** @type {string} */ tag, n = STORM) =>
  Array.from({ length: n }, (_, i) => tool("gh", [`${tag}${i}`]));

const was = C.programs.gh;
before(() => {
  C.programs.gh = gh;
  // Only Date: setTimeout and the child processes keep real time.
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
});
after(() => {
  mock.timers.reset();
  C.programs.gh = was;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("limiter storm: never more than 2 gh calls at once, and every call answered", async () => {
  fs.writeFileSync(log, "");
  const results = await Promise.all(storm("poll"));
  assert.equal(results.length, STORM);
  assert.ok(results.every((r) => r.code === 0));
  assert.equal(started().length, STORM, "every call reached gh once");
  assert.equal(mostAtOnce(), 2, "the cap (2) is never exceeded");
});

test("limiter storm: a rate limit during a storm opens one backoff, not one per call", async () => {
  fs.writeFileSync(log, "");
  fs.writeFileSync(limitFlag, "");
  const t0 = performance.now();
  const results = await Promise.all(storm("limited"));
  const took = performance.now() - t0;
  // Only the calls already running when GitHub said so reach it; the rest are
  // refused at once, without asking.
  assert.equal(started().length, 2, "only the 2 calls in flight reached gh");
  assert.ok(results.every((r) => r.code === 1));
  assert.ok(
    took < 20 * LATENCY_S * 1000,
    `the storm took ${took.toFixed(0)} ms`,
  );
  // Two calls answered "rate limited" together: that is one rate limit, so the
  // backoff is the first one's minute, not doubled for the second.
  const waits = results.map(waitOf).filter((w) => !Number.isNaN(w));
  assert.equal(waits.length, STORM - 2);
  assert.ok(
    waits.every((w) => w <= 60),
    `backoff ${Math.max(...waits)} s, after one rate limit`,
  );
  console.log(
    `  ${STORM} calls into a rate limit: ${took.toFixed(0)} ms, ${started().length} reached gh, backoff ${Math.max(...waits)} s`,
  );
});

test("limiter storm: a click waits at most one call during a backoff", async () => {
  // Still in the backoff above, and GitHub answers again.
  fs.rmSync(limitFlag);
  fs.writeFileSync(log, "");
  const lookups = storm("bg");
  const t0 = performance.now();
  const click = await tool("gh", ["click"], { urgent: true });
  const waited = performance.now() - t0;
  const bg = await Promise.all(lookups);
  assert.equal(click.code, 0, "the click asks GitHub despite the backoff");
  assert.ok(
    bg.every((r) => r.code === 1),
    "background calls wait it out",
  );
  assert.deepEqual(started(), ["start click"]);
  // Refused calls take their slot only briefly: the click waits for no gh call.
  assert.ok(
    waited < 10 * LATENCY_S * 1000,
    `the click waited ${waited.toFixed(0)} ms`,
  );
  console.log(
    `  click during a backoff, behind ${STORM} queued: ${waited.toFixed(0)} ms`,
  );
});

test("limiter storm: once the backoff has passed, no call is lost", async () => {
  mock.timers.tick(61_000);
  fs.writeFileSync(log, "");
  const results = await Promise.all(storm("after"));
  assert.ok(results.every((r) => r.code === 0));
  assert.deepEqual(
    results.map((r) => r.stdout.trim()),
    Array.from({ length: STORM }, (_, i) => `ok after${i}`),
    "each call gets its own answer",
  );
  assert.equal(started().length, STORM);
  assert.equal(mostAtOnce(), 2);
});

test("limiter storm: a second rate limit after the first doubles the backoff", async () => {
  fs.writeFileSync(limitFlag, "");
  // The success above reset it: one rate limit is a minute again.
  await tool("gh", ["first"]);
  const r1 = await tool("gh", ["refused"]);
  assert.equal(waitOf(r1), 60);
  mock.timers.tick(61_000);
  await tool("gh", ["second"]);
  const r2 = await tool("gh", ["refused"]);
  assert.equal(waitOf(r2), 120, "a repeat doubles it");
  fs.rmSync(limitFlag);
});
