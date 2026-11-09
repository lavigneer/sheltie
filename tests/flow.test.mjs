// The workflow's next steps (conflicts and PRs without checks too), the PR
// label, and Ready waiting for the agent with workflow.readyWhen "agent".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { live } from "herdr";
import { C, useConfig } from "../src/config.js";
import {
  agentSaysDone,
  glyphOf,
  nextSteps,
  prEvents,
  prLabel,
  rowSteps,
  runStep,
  START_MS,
} from "../src/flow.js";

const draft = {
  number: 7,
  state: "OPEN",
  draft: true,
  checks: "passed",
  mergeable: "MERGEABLE",
  unresolved: 0,
  review: "REVIEW_REQUIRED",
};
const approved = { ...draft, draft: false, review: "APPROVED" };
const ids = (pr, opts) => nextSteps(pr, opts).map((s) => s.id);

// A space at /w whose agent (Claude Code, reporting its status) is t7, with
// the given labels on its terminal.
function agentAt(labels) {
  live.spaces = [{ id: "s1", folder: "/w", tabs: [{ id: "tab1" }] }];
  live.agents = [{ space: "s1", address: "t7" }];
  live.terminals = [{ address: "t7", labels }];
  return live.spaces[0];
}

afterEach(() => {
  Object.assign(live, { panes: [], spaces: [], agents: [], terminals: [] });
  useConfig({});
});

test('readyWhen "green" (the default): Ready once green, whatever the agent says', () => {
  assert.equal(C.workflow.readyWhen, "green");
  assert.deepEqual(ids(draft), ["ready"]);
  assert.deepEqual(ids(draft, { agentDone: false }), ["ready"]);
  assert.deepEqual(ids({ ...draft, checks: "pending" }), []);
  assert.deepEqual(ids({ ...draft, unresolved: 2 }), ["address-comments"]);
});

test("no Ready while the agent is working: it may still be iterating", () => {
  assert.deepEqual(ids(draft, { working: true }), []);
});

test('readyWhen "agent": Ready only once the agent says the PR is done', () => {
  useConfig({ workflow: { readyWhen: "agent" } });
  assert.deepEqual(ids(draft), []);
  assert.deepEqual(ids(draft, { agentDone: true }), ["ready"]);
  // Still only when green and nothing is unresolved.
  assert.deepEqual(ids({ ...draft, checks: "failed" }, { agentDone: true }), [
    "fix-ci",
  ]);
  assert.deepEqual(ids({ ...draft, unresolved: 1 }, { agentDone: true }), [
    "address-comments",
  ]);
  // Steps after Ready don't wait for it.
  assert.deepEqual(ids(approved), ["merge"]);
});

test("agentSaysDone: the space's agent terminal has pr=ready", () => {
  assert.equal(agentSaysDone(null), false);
  assert.equal(agentSaysDone(agentAt({})), false);
  assert.equal(agentSaysDone(agentAt({ pr: "" })), false);
  assert.equal(agentSaysDone(agentAt({ pr: "ready" })), true);
  // Another terminal's label doesn't count.
  const space = agentAt({});
  live.terminals.push({ address: "t8", labels: { pr: "ready" } });
  assert.equal(agentSaysDone(space), false);
});

test("an agent step clears pr=ready before it's sent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "htf-flow-"));
  const log = path.join(dir, "hc.log");
  const hc = path.join(dir, "hc");
  fs.writeFileSync(hc, `#!/bin/sh\necho "$*" >>'${log}'\n`, { mode: 0o755 });
  useConfig({ programs: { ...C.programs, hc } });
  agentAt({ pr: "ready" });
  const note = await runStep(
    "fix-ci",
    { path: "/w", branch: "b", repo: {} },
    draft,
  );
  assert.equal(note, "sent /fix-ci");
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
    "label t7 pr=",
    "send t7 /fix-ci",
  ]);
});

test("a conflicting PR: only Resolve conflicts, labelled conflicts (bad)", () => {
  const conflicting = { ...draft, mergeable: "CONFLICTING", checks: null };
  assert.deepEqual(ids(conflicting), ["resolve-conflicts"]);
  assert.equal(nextSteps(conflicting)[0].label, "Resolve conflicts");
  assert.equal(nextSteps(conflicting)[0].kind, "agent");
  assert.equal(nextSteps(conflicting)[0].short, "Conflicts");
  // Not Merge once approved, nor anything else it has to do first.
  assert.deepEqual(ids({ ...approved, mergeable: "CONFLICTING" }), [
    "resolve-conflicts",
  ]);
  assert.deepEqual(ids({ ...conflicting, checks: "failed", unresolved: 2 }), [
    "resolve-conflicts",
  ]);
  // Nor Ready when the agent says it's done.
  useConfig({ workflow: { readyWhen: "agent" } });
  assert.deepEqual(ids(conflicting, { agentDone: true }), [
    "resolve-conflicts",
  ]);
  // Its agent is busy: nothing.
  assert.deepEqual(ids(conflicting, { working: true }), []);

  assert.deepEqual(prLabel(conflicting), {
    text: "#7 draft conflicts",
    head: "#7 draft",
    tail: "conflicts",
    tone: "bad",
    short: "#7 conflicts",
    glyph: "!",
  });
  assert.deepEqual(prLabel({ ...approved, mergeable: "CONFLICTING" }), {
    text: "#7 approved ✓ conflicts",
    head: "#7 approved",
    tail: "✓ conflicts",
    tone: "bad",
    short: "#7 conflicts",
    glyph: "!",
  });
  // Merged or closed: no longer about conflicts.
  assert.equal(prLabel({ ...conflicting, state: "MERGED" }).text, "#7 merged");
});

test("mergeable UNKNOWN: neither Ready nor Merge, nor Resolve conflicts", () => {
  const unknown = { ...draft, mergeable: "UNKNOWN" };
  assert.deepEqual(ids(unknown), []);
  assert.deepEqual(ids({ ...approved, mergeable: "UNKNOWN" }), []);
  assert.deepEqual(ids({ ...unknown, checks: "failed" }), ["fix-ci"]);
  assert.deepEqual(prLabel(unknown), {
    text: "#7 draft ✓",
    head: "#7 draft",
    tail: "✓",
    tone: null,
    short: "#7 draft",
    glyph: "◌",
  });
});

test("an open PR with no checks is never offered Ready or Merge", () => {
  assert.deepEqual(ids({ ...draft, checks: null }), []);
  assert.deepEqual(ids({ ...approved, checks: null }), []);
  assert.deepEqual(ids({ ...draft, checks: null, unresolved: 1 }), [
    "address-comments",
  ]);
  // Nor is it labelled good for being approved.
  assert.deepEqual(prLabel({ ...approved, checks: null }), {
    text: "#7 approved",
    head: "#7 approved",
    tail: "",
    tone: null,
    short: "#7 approved",
    glyph: "✓",
  });
  assert.deepEqual(prLabel(approved), {
    text: "#7 approved ✓",
    head: "#7 approved",
    tail: "✓",
    tone: "good",
    short: "#7 approved",
    glyph: "✓",
  });
  // With counts, GitHub's "passed/total" follows the icon.
  assert.deepEqual(
    prLabel({ ...approved, checks: "failed", checksPassed: 2, checksTotal: 5 }),
    {
      text: "#7 approved ✗ 2/5",
      head: "#7 approved",
      tail: "✗ 2/5",
      tone: "bad",
      short: "#7 CI failed",
      glyph: "✗",
    },
  );
  // Changes requested with no checks: the tone still has a whole tail.
  assert.deepEqual(
    prLabel({ ...draft, checks: null, review: "CHANGES_REQUESTED" }),
    {
      text: "#7 draft changes requested",
      head: "#7 draft changes requested",
      tail: "●",
      tone: "bad",
      short: "#7 changes",
      glyph: "±",
    },
  );
  // With checks that passed, it's as before.
  assert.deepEqual(ids(draft), ["ready"]);
  assert.deepEqual(ids(approved), ["merge"]);
  assert.deepEqual(ids({ ...approved, autoMerge: true }), []);
});

test("resolve-conflicts is an agent step, sent like the others", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "htf-flow-"));
  const log = path.join(dir, "hc.log");
  const hc = path.join(dir, "hc");
  fs.writeFileSync(hc, `#!/bin/sh\necho "$*" >>'${log}'\n`, { mode: 0o755 });
  useConfig({ programs: { ...C.programs, hc } });
  agentAt({});
  const note = await runStep(
    "resolve-conflicts",
    { path: "/w", branch: "b", repo: {} },
    draft,
  );
  assert.equal(note, "sent /resolve-conflicts");
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
    "label t7 pr=",
    "send t7 /resolve-conflicts",
  ]);
});

// A ready PR, CI passed, nothing unresolved, auto-merge off.
const ready = { ...draft, draft: false };

test("no Merge while the agent is working: it may still be pushing", () => {
  assert.deepEqual(
    ids({ ...ready, review: "APPROVED" }, { working: true }),
    [],
  );
});

test("Merge: approved, or no review required, and CI passed, without auto-merge", () => {
  const merge = (pr) => nextSteps(pr).find((s) => s.id === "merge");
  assert.deepEqual(ids({ ...ready, review: "APPROVED" }), ["merge"]);
  // A repo without required reviews: reviewDecision is empty.
  assert.deepEqual(ids({ ...ready, review: null }), ["merge"]);
  assert.equal(
    merge({ ...ready, review: null }).confirm,
    true,
    "asks for a second click",
  );
  // Never while a review is required or changes are requested.
  assert.deepEqual(ids({ ...ready, review: "REVIEW_REQUIRED" }), []);
  assert.deepEqual(ids({ ...ready, review: "CHANGES_REQUESTED" }), [
    "address-comments",
  ]);
  // Never unless CI passed.
  for (const review of [null, "APPROVED"]) {
    assert.deepEqual(ids({ ...ready, review, checks: "failed" }), ["fix-ci"]);
    assert.deepEqual(ids({ ...ready, review, checks: "pending" }), []);
    assert.deepEqual(
      ids({ ...ready, review, checks: null }),
      [],
      "missing checks",
    );
    assert.deepEqual(ids({ ...ready, review, unresolved: 1 }), [
      "address-comments",
    ]);
    assert.deepEqual(
      ids({ ...ready, review, autoMerge: true }),
      [],
      "auto-merge on",
    );
    assert.deepEqual(
      ids({ ...ready, review, mergeable: "UNKNOWN" }),
      [],
      "mergeable unknown",
    );
    assert.deepEqual(ids({ ...ready, review, mergeable: "CONFLICTING" }), [
      "resolve-conflicts",
    ]);
  }
  // Not for a draft, nor once merged (Finish) or closed.
  assert.deepEqual(ids({ ...ready, draft: true, review: null }), ["ready"]);
  assert.deepEqual(ids({ ...ready, review: null, state: "MERGED" }), [
    "finish",
  ]);
});

test("Merge: workflow.mergeWithoutReview false only offers it once approved", () => {
  useConfig({ workflow: { mergeWithoutReview: false } });
  assert.deepEqual(ids({ ...ready, review: null }), []);
  assert.deepEqual(ids({ ...ready, review: "APPROVED" }), ["merge"]);
});

test("Merge: workflow.confirmMerge false runs it on the first click", () => {
  useConfig({ workflow: { confirmMerge: false } });
  assert.equal(nextSteps({ ...ready, review: null })[0].confirm, false);
});

// PR change events: each transition from one snapshot to the next.
test("prEvents: each transition from was to now", () => {
  const open = { ...draft, checks: "pending", settled: "MERGEABLE" };
  const cases = [
    ["nothing changed", open, {}, []],
    [
      "CI passed on a draft",
      open,
      { checks: "passed" },
      [["CI passed", "success", "Ready to mark ready for review."]],
    ],
    [
      "CI passed, ready",
      open,
      { checks: "passed", draft: false },
      [["CI passed", "success", undefined]],
    ],
    [
      "CI failed",
      open,
      { checks: "failed" },
      [["CI failed", "error", undefined]],
    ],
    [
      "CI already passed",
      { ...open, checks: "passed" },
      { checks: "passed" },
      [],
    ],
    [
      "new conflict",
      open,
      { mergeable: "CONFLICTING" },
      [
        [
          "merge conflicts",
          "warning",
          "It conflicts with its base, so CI won't run: Resolve conflicts.",
        ],
      ],
    ],
    [
      "conflict already told",
      { ...open, settled: "CONFLICTING" },
      { mergeable: "CONFLICTING" },
      [],
    ],
    [
      "conflict on a closed PR",
      open,
      { mergeable: "CONFLICTING", state: "CLOSED" },
      [],
    ],
    [
      "one new comment",
      open,
      { unresolved: 1 },
      [["1 new review comment", "warning", undefined]],
    ],
    [
      "comments from unknown",
      { ...open, unresolved: null },
      { unresolved: 3 },
      [["3 new review comments", "warning", undefined]],
    ],
    ["comments resolved", { ...open, unresolved: 2 }, { unresolved: 1 }, []],
    [
      "approved",
      open,
      { review: "APPROVED" },
      [["approved", "success", undefined]],
    ],
    [
      "approved with auto-merge",
      open,
      { review: "APPROVED", autoMerge: true },
      [["approved", "success", "Auto-merge will merge it."]],
    ],
    [
      "still approved",
      { ...open, review: "APPROVED" },
      { review: "APPROVED" },
      [],
    ],
    [
      "changes requested",
      open,
      { review: "CHANGES_REQUESTED" },
      [["changes requested", "warning", undefined]],
    ],
    [
      "merged",
      open,
      { state: "MERGED" },
      [
        [
          "merged",
          "success",
          "Finish removes the worktree and resolves the ticket.",
        ],
      ],
    ],
    ["already merged", { ...open, state: "MERGED" }, { state: "MERGED" }, []],
    [
      "several at once, in order",
      open,
      { checks: "failed", unresolved: 2, review: "CHANGES_REQUESTED" },
      [
        ["CI failed", "error", undefined],
        ["2 new review comments", "warning", undefined],
        ["changes requested", "warning", undefined],
      ],
    ],
  ];
  for (const [name, was, change, want] of cases)
    assert.deepEqual(
      prEvents(was, { ...was, ...change }).map((e) => [
        e.title,
        e.level,
        e.body,
      ]),
      want,
      name,
    );
});

test("a PR's short word and glyph: the state that matters most", () => {
  const open = { number: 3, state: "OPEN", draft: false, review: null };
  const short = (pr) => prLabel({ ...open, ...pr }).short;
  assert.equal(short({ state: "MERGED", checks: "failed" }), "#3 merged");
  assert.equal(short({ state: "CLOSED" }), "#3 closed");
  assert.equal(
    short({ mergeable: "CONFLICTING", checks: "failed" }),
    "#3 conflicts",
  );
  assert.equal(
    short({ checks: "failed", review: "CHANGES_REQUESTED" }),
    "#3 CI failed",
  );
  assert.equal(
    short({ review: "CHANGES_REQUESTED", draft: true }),
    "#3 changes",
  );
  assert.equal(short({ draft: true }), "#3 draft");
  assert.equal(short({ review: "APPROVED" }), "#3 approved");
  assert.equal(short({ review: "REVIEW_REQUIRED" }), "#3 in review");
});

test("Address comments' short label keeps the count", () => {
  const pr = {
    number: 3,
    state: "OPEN",
    draft: true,
    review: null,
    checks: "pending",
    mergeable: "MERGEABLE",
    unresolved: 12,
  };
  const s = nextSteps(pr).find((x) => x.id === "address-comments");
  assert.equal(s.label, "Address 12 comments");
  assert.equal(s.short, "12 comments");
});

test("an open PR's label names its review state, and ready-to-merge is good", () => {
  const open = { ...draft, draft: false };
  assert.deepEqual(prLabel(open), {
    text: "#7 in review ✓",
    head: "#7 in review",
    tail: "✓",
    tone: null,
    short: "#7 in review",
    glyph: "◑",
  });
  assert.equal(prLabel({ ...open, review: null }).tone, "good");
  assert.equal(prLabel({ ...open, review: "APPROVED" }).tone, "good");
});

const rowIds = (opts) => rowSteps(opts).map((s) => s.id);
const found = { state: "found" };

test("rowSteps: no Draft PR before the PR lookup answers, or when it failed", () => {
  assert.deepEqual(rowIds({ lookup: null }), []);
  assert.deepEqual(rowIds({ lookup: { state: "failed" } }), []);
  assert.deepEqual(rowIds({ lookup: found }), ["draft-pr"]);
  assert.deepEqual(rowIds({ hub: true, lookup: found }), []);
});

test("rowSteps: none while a step runs or its PR is stale after one", () => {
  assert.deepEqual(rowIds({ pr: draft, last: { phase: "running" } }), []);
  assert.deepEqual(
    rowIds({ pr: draft, last: { phase: "done", staleAt: 1 } }),
    [],
  );
  assert.deepEqual(rowIds({ pr: draft, last: { phase: "done" } }), ["ready"]);
});

test("rowSteps: a new space's agent gets START_MS to start working", () => {
  const at = (now, status = "idle") =>
    rowIds({ lookup: found, status, bornAt: 0, now });
  assert.deepEqual(at(START_MS - 1), []);
  assert.deepEqual(at(START_MS), ["draft-pr"]);
  assert.deepEqual(at(0, "working"), []);
});

test("glyphOf: failed > no space > working > the agent's status", () => {
  assert.equal(glyphOf(true, { status: "working" }), "failed");
  assert.equal(glyphOf(true, null), "failed");
  assert.equal(glyphOf(false, null), "no-space");
  assert.equal(glyphOf(false, { status: "working" }), "working");
  assert.equal(glyphOf(false, { status: "blocked" }), "blocked");
});
