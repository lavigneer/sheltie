// PR details (prs.js): the pure parsePR stage rules, and prDetails against the
// demo's fake GitHub.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { prepare, state, writeState } from "./demo.mjs";

let parsePR, prDetails;
before(async () => {
  prepare("jira");
  await (await import("../src/config.js")).configReady();
  ({ parsePR, prDetails } = await import("../src/prs.js"));
});

// A pullRequest node as GitHub's GraphQL answers it.
const node = ({
  number = 1,
  state = "OPEN",
  mergeable = "MERGEABLE",
  checks = [],
  threads = [],
} = {}) => ({
  number,
  url: `https://github.com/a/b/pull/${number}`,
  title: "T",
  body: null,
  state,
  isDraft: false,
  reviewDecision: "",
  headRefName: "me/X-1",
  headRefOid: "abc",
  mergeable,
  autoMergeRequest: null,
  commits: {
    nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }],
  },
  reviewThreads: { nodes: threads.map((isResolved) => ({ isResolved })) },
});
const run = (conclusion, isRequired = true) => ({ conclusion, isRequired });

test("parsePR: no node is no PR", () => {
  assert.equal(parsePR("a/b", null), null);
});

test("parsePR: checks roll up to passed, failed or pending", () => {
  const of = (checks) => parsePR("a/b", node({ checks }));
  assert.equal(of([]).checks, null);
  assert.equal(of([run("SUCCESS"), run("SKIPPED")]).checks, "passed");
  assert.equal(of([run("SUCCESS"), run("FAILURE")]).checks, "failed");
  // Running, or a result we don't know: pending, never passed.
  assert.equal(
    of([run("SUCCESS"), { status: "IN_PROGRESS" }]).checks,
    "pending",
  );
  assert.equal(of([run("WHATEVER")]).checks, "pending");
  // Status contexts report a state.
  assert.equal(of([{ state: "ERROR" }]).checks, "failed");
  const p = of([run("SUCCESS"), run("FAILURE"), run("SUCCESS")]);
  assert.deepEqual([p.checksPassed, p.checksTotal], [2, 3]);
});

test("parsePR: requiredOnly leaves out checks merging doesn't need", () => {
  const n = node({ checks: [run("SUCCESS"), run("FAILURE", false)] });
  assert.equal(parsePR("a/b", n).checks, "failed");
  const p = parsePR("a/b", n, null, { requiredOnly: true });
  assert.equal(p.checks, "passed");
  assert.deepEqual([p.checksPassed, p.checksTotal], [1, 1]);
});

test("parsePR: settled carries the last worked-out mergeable over UNKNOWN", () => {
  const conflicting = parsePR("a/b", node({ mergeable: "CONFLICTING" }));
  assert.equal(conflicting.settled, "CONFLICTING");
  const unknown = node({ mergeable: null });
  assert.equal(parsePR("a/b", unknown).mergeable, "UNKNOWN");
  assert.equal(parsePR("a/b", unknown, conflicting).settled, "CONFLICTING");
  // Another PR's details don't carry over.
  assert.equal(
    parsePR("a/b", unknown, { ...conflicting, number: 2 }).settled,
    null,
  );
});

test("parsePR: unresolved threads count on open PRs only", () => {
  const threads = [false, true, false];
  assert.equal(parsePR("a/b", node({ threads })).unresolved, 2);
  assert.equal(
    parsePR("a/b", node({ threads, state: "MERGED" })).unresolved,
    null,
  );
});

test("prDetails: requiredOnly leaves out checks merging doesn't need", async () => {
  const s = state();
  s.prs.find((p) => p.repo === "acme/docs" && p.number === 56).optionalChecks =
    ["FAILURE"];
  writeState(s);
  try {
    const all = await prDetails("acme/docs", 56);
    assert.equal(all.checks, "failed");
    assert.equal(all.checksTotal, 2);
    const opts = { requiredOnly: true };
    const required = await prDetails("acme/docs", 56, null, opts);
    assert.equal(required.checks, "passed");
    assert.equal(required.checksPassed, 1);
    assert.equal(required.checksTotal, 1);
    // By branch it asks again by number, for which checks are required.
    const byBranch = await prDetails("acme/docs", required.branch, null, opts);
    assert.equal(byBranch.checks, "passed");
  } finally {
    delete s.prs.find((p) => p.repo === "acme/docs" && p.number === 56)
      .optionalChecks;
    writeState(s);
  }
});
