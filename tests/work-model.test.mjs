// WorkModel (#246): the Work sidebar's groups, adoption and view, with no View.
import assert from "node:assert/strict";
import { test } from "node:test";

const { WorkStore } = await import("../src/work.js");
const { WorkModel } = await import("../src/work-model.js");
const { fixtureSpaces } = await import("../src/spaces.js");

const tracker = {
  name: "GitHub",
  keysIn: (text) =>
    [...(text ?? "").matchAll(/issue-(\d+)/g)].map((m) => `#${m[1]}`),
  labelOf: (k) => k,
};
const LIVE = fixtureSpaces({});

// A model over one repo whose worktrees are `branches` (changeable).
function model(branches) {
  const repo = { slug: "me/app", path: "/src/app", name: "app", tracker };
  const state = { branches };
  const store = new WorkStore({
    sources: {
      repoState: async () => ({
        worktrees: state.branches.map((branch) => ({
          path: `/wt/${branch}`,
          branch,
        })),
        branches: new Map(state.branches.map((b) => [b, { local: true }])),
        mainBranch: "main",
        linked: [],
      }),
      prDetails: async () => null,
    },
  });
  return { m: new WorkModel({ store }), repo, repos: [repo], state };
}

test("WorkModel.scan: builds a group per repo, with each branch's ticket", async () => {
  const { m, repo } = model(["issue-1", "spike"]);
  assert.equal(m.groups, null);
  assert.equal(await m.scan([repo]), true);
  const [g] = m.groups;
  assert.equal(g.repo, repo);
  assert.deepEqual(
    { path: g.hub.path, branch: g.hub.branch, hub: g.hub.hub },
    { path: "/src/app", branch: "main", hub: true },
  );
  assert.deepEqual(
    g.worktrees.map((w) => [w.branch, w.handle?.key ?? null]),
    [
      ["issue-1", "#1"],
      ["spike", null],
    ],
  );
  assert.deepEqual([...m.knownFolders()].sort(), [
    "/src/app",
    "/wt/issue-1",
    "/wt/spike",
  ]);
});

test("WorkModel.scan: the same again keeps the groups; a new worktree rebuilds them", async () => {
  const { m, repos, state } = model(["issue-1"]);
  await m.scan(repos);
  const groups = m.groups;
  assert.equal(await m.scan(repos), false);
  assert.equal(m.groups, groups);
  state.branches = ["issue-1", "issue-2"];
  assert.equal(await m.scan(repos), true);
  assert.notEqual(m.groups, groups);
  assert.equal(m.groups[0].worktrees.length, 2);
});

test("WorkModel.adopt: a branch naming no ticket takes the one its PR names", async () => {
  const { m, repo } = model(["spike", "issue-1"]);
  await m.scan([repo]);
  // No PR, or another branch's: nothing.
  assert.equal(m.adopt("me/app#spike", null), false);
  assert.equal(
    m.adopt("me/app#other", { number: 3, title: "Fixes issue-9" }),
    false,
  );
  // A PR naming no ticket: nothing.
  assert.equal(m.adopt("me/app#spike", { number: 3, title: "Tidy" }), false);
  assert.equal(
    m.adopt("me/app#spike", { number: 3, title: "Fixes issue-7" }),
    true,
  );
  const [spike, own] = m.groups[0].worktrees;
  assert.equal(spike.handle.key, "#7");
  // A branch with its own ticket keeps it.
  assert.equal(own.handle.key, "#1");
  // Adopted already: no change.
  assert.equal(
    m.adopt("me/app#spike", { number: 3, title: "Fixes issue-8" }),
    false,
  );
  assert.equal(spike.handle.key, "#7");
});

test("WorkModel.adopt: before the first scan, nothing", () => {
  const { m } = model([]);
  assert.equal(m.adopt("me/app#x", { title: "issue-1" }), false);
});

test("WorkModel.view and report: the hub, then a row per worktree", async () => {
  const { m, repo } = model(["issue-1"]);
  await m.scan([repo]);
  m.steps.set("/wt/issue-1", { phase: "failed", text: "boom", at: 5 });
  const view = m.view(LIVE, 0, { width: 400 });
  assert.equal(view.active, null);
  assert.deepEqual(
    view.rows.map((r) => r.w.path),
    ["/src/app", "/wt/issue-1"],
  );
  const report = m.report(view.rows, LIVE, 9);
  assert.equal(report.at, 9);
  assert.equal(report.loaded, true);
  assert.equal(report.rows[1].key, "#1");
  assert.deepEqual(report.rows[1].last, {
    phase: "failed",
    text: "boom",
    at: 5,
  });
});

test("WorkModel.setUsage: true only when a folder's cost moved", () => {
  const { m } = model([]);
  assert.equal(m.setUsage([{ dir: "/wt/a", cost: 1 }]), true);
  assert.equal(m.setUsage([{ dir: "/wt/a", cost: 1 }]), false);
  assert.equal(m.setUsage([{ dir: "/wt/a", cost: 2 }]), true);
});
