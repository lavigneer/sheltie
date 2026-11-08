// The workflow's next steps, and Ready waiting for the agent with
// workflow.readyWhen "agent".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { live } from "herdr";
import { C, useConfig } from "../src/config.js";
import { agentSaysDone, nextSteps, runStep } from "../src/flow.js";

const draft = { state: "OPEN", draft: true, checks: "passed", unresolved: 0, review: "REVIEW_REQUIRED" };
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

test('readyWhen "agent": Ready only once the agent says the PR is done', () => {
  useConfig({ workflow: { readyWhen: "agent" } });
  assert.deepEqual(ids(draft), []);
  assert.deepEqual(ids(draft, { agentDone: true }), ["ready"]);
  // Still only when green and nothing is unresolved.
  assert.deepEqual(ids({ ...draft, checks: "failed" }, { agentDone: true }), ["fix-ci"]);
  assert.deepEqual(ids({ ...draft, unresolved: 1 }, { agentDone: true }), ["address-comments"]);
  // Steps after Ready don't wait for it.
  assert.deepEqual(ids({ ...draft, draft: false, review: "APPROVED" }), ["merge"]);
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
  const note = await runStep("fix-ci", { path: "/w", branch: "b", repo: {} }, draft);
  assert.equal(note, "sent /fix-ci");
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
    "label t7 pr=",
    "send t7 /fix-ci",
  ]);
});
