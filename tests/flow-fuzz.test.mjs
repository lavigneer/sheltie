// Property tests: nextSteps/stageOf invariants over random PR states and
// workflow settings. Seeded; set FUZZ_SEED to replay a failing run.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { useConfig } from "../src/config.js";
import { nextSteps, stageOf } from "../src/flow.js";

const SEED = Number(process.env.FUZZ_SEED ?? Date.now() % 2 ** 32) >>> 0;
const RUNS = 2000;

// mulberry32: a small seeded PRNG.
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function gen(rand) {
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const pr =
    rand() < 0.1
      ? null
      : {
          number: 1 + Math.floor(rand() * 1000),
          state: pick(["OPEN", "OPEN", "MERGED", "CLOSED"]),
          draft: pick([true, false]),
          checks: pick([null, "pending", "failed", "passed"]),
          mergeable: pick(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
          review: pick([null, "REVIEW_REQUIRED", "APPROVED", "CHANGES_REQUESTED"]),
          autoMerge: pick([true, false]),
          unresolved: pick([null, 0, 0, 1, 3]),
        };
  const flags = { working: pick([true, false]), agentDone: pick([true, false]) };
  const workflow = {
    readyWhen: pick(["green", "agent"]),
    mergeWithoutReview: pick([true, false]),
    confirmMerge: pick([true, false]),
    confirmFinish: pick([true, false]),
  };
  return { pr, flags, workflow };
}

afterEach(() => useConfig({}));

test(`nextSteps/stageOf invariants hold over random PR states (FUZZ_SEED=${SEED})`, () => {
  const rand = rng(SEED);
  for (let i = 0; i < RUNS; i++) {
    const { pr, flags, workflow } = gen(rand);
    const ctx = `FUZZ_SEED=${SEED} run ${i}: ${JSON.stringify({ pr, flags, workflow })}`;
    useConfig({ workflow });
    const stage = stageOf(pr);
    const steps = nextSteps(pr, flags);
    const ids = steps.map((s) => s.id);

    assert.equal(new Set(ids).size, ids.length, `duplicate step ids ${ids}; ${ctx}`);
    if (ids.includes("merge")) {
      assert.notEqual(pr.mergeable, "CONFLICTING", `merge while conflicting; ${ctx}`);
      assert.notEqual(pr.checks, "failed", `merge with failed checks; ${ctx}`);
    }
    if (ids.includes("ready"))
      assert.ok(pr?.draft && stage === "draft", `ready on non-draft; ${ctx}`);
    if (stage === "merged") assert.deepEqual(ids, ["finish"], ctx);
    if (stage === "closed") assert.deepEqual(ids, ["clean-up"], ctx);
    if (flags.working)
      assert.ok(steps.every((s) => s.kind !== "agent"), `agent step while working; ${ctx}`);
  }
});
