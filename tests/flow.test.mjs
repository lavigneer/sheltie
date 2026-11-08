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
  nextSteps,
  prEvents,
  prLabel,
  runStep,
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
    tone: "bad",
  });
  assert.deepEqual(prLabel({ ...approved, mergeable: "CONFLICTING" }), {
    text: "#7 approved ✓ conflicts",
    tone: "bad",
  });
  // Merged or closed: no longer about conflicts.
  assert.equal(prLabel({ ...conflicting, state: "MERGED" }).text, "#7 merged");
});

test("mergeable UNKNOWN: neither Ready nor Merge, nor Resolve conflicts", () => {
  const unknown = { ...draft, mergeable: "UNKNOWN" };
  assert.deepEqual(ids(unknown), []);
  assert.deepEqual(ids({ ...approved, mergeable: "UNKNOWN" }), []);
  assert.deepEqual(ids({ ...unknown, checks: "failed" }), ["fix-ci"]);
  assert.deepEqual(prLabel(unknown), { text: "#7 draft ✓", tone: null });
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
    tone: null,
  });
  assert.deepEqual(prLabel(approved), { text: "#7 approved ✓", tone: "good" });
  // With counts, GitHub's "passed/total" follows the icon.
  assert.deepEqual(
    prLabel({ ...approved, checks: "failed", checksPassed: 2, checksTotal: 5 }),
    { text: "#7 approved ✗ 2/5", tone: "bad" },
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
