// WorkModel (#246): the Work sidebar's groups, adoption and view, with no View.
import assert from "node:assert/strict";
import { test } from "node:test";
import { perRef } from "./fake-tools.mjs";

const { WorkStore } = await import("../src/work.js");
const { WorkModel, stackOrder } = await import("../src/work-model.js");
const { fixtureSpaces } = await import("../src/spaces.js");
const { STEP, stepDone, stepState } = await import("../src/flow.js");

const tracker = {
  name: "GitHub",
  keysIn: (text) =>
    [...(text ?? "").matchAll(/issue-(\d+)/g)].map((m) => `#${m[1]}`),
  labelOf: (k) => k,
};
const LIVE = fixtureSpaces({});

// A model over one repo whose worktrees are `branches` (changeable). `now`:
// the store's clock (its caches' too).
function model(branches, { now = Date.now } = {}) {
  const repo = { slug: "me/app", path: "/src/app", name: "app", tracker };
  const state = { branches };
  const store = new WorkStore({
    now,
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
      prDetailsMany: perRef(async () => null),
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

test("WorkModel.lookups: a linked PR found wakes before its lookup lands", async () => {
  const { m, repo } = model(["issue-1"]);
  tracker.linkedPRs = async () =>
    new Map([["#1", [{ slug: "me/lib", number: 5 }]]]);
  let land;
  const landed = new Promise((r) => (land = r));
  m.store.sources.prDetailsMany = perRef(async () => {
    await landed;
    return null;
  });
  await m.scan([repo]);
  // The ticket is known already: only the linked PR is new.
  await m.store.tickets.refresh("#1", async () => ({ title: "One" }));
  const was = m.revision;
  let changes = 0;
  const done = m.lookups(false, { changed: () => changes++ });
  while (!m.store.linked.get("#1")) await new Promise((r) => setTimeout(r));
  await new Promise((r) => setTimeout(r));
  assert.equal(changes, 1);
  assert.notEqual(m.revision, was);
  land();
  await done;
  delete tracker.linkedPRs;
});

// A step's stale mark (flow.js: STEP.STALE) is cleared by a PR lookup asked
// after the step answered; the lookups below run at the clock's `clock.t`.
test("WorkModel.lookups: a step answered during a lookup is refreshed by the next", async () => {
  const clock = { t: 100 };
  const { m, repo } = model(["issue-1"], { now: () => clock.t });
  tracker.linkedPRs = async () => new Map();
  await m.scan([repo]);
  await m.store.tickets.refresh("#1", async () => ({ title: "One" }));
  const path = "/wt/issue-1";
  m.store.sources.prDetailsMany = perRef(async () => {
    // Answers at 150, while this lookup (asked at 100) is in flight.
    m.steps.set(path, stepDone("ok", 150));
    return null;
  });
  await m.lookups(false);
  assert.equal(stepState(m.steps.get(path)), STEP.STALE);
  // Due again (its PR entry is older than PR_MS), asked after the answer.
  clock.t = 1_000_000;
  m.store.sources.prDetailsMany = perRef(async () => null);
  await m.lookups(false);
  assert.equal(stepState(m.steps.get(path)), STEP.DONE);
  delete tracker.linkedPRs;
});

test("WorkModel.lookups: a failed PR lookup still refreshes a stale step", async () => {
  const clock = { t: 100 };
  const { m, repo } = model(["issue-1"], { now: () => clock.t });
  tracker.linkedPRs = async () => new Map();
  await m.scan([repo]);
  await m.store.tickets.refresh("#1", async () => ({ title: "One" }));
  const path = "/wt/issue-1";
  m.steps.set(path, stepDone("ok", 50));
  m.store.sources.prDetailsMany = perRef(async () => {
    throw new Error("gh unreachable");
  });
  await m.lookups(false);
  assert.equal(m.store.prEntry(repo, "issue-1").state, "failed");
  // Not held back for a retry: the row is no longer stale.
  assert.equal(stepState(m.steps.get(path)), STEP.DONE);
  delete tracker.linkedPRs;
});

test("WorkModel.revision: moves with a scan, an adoption or a cost", async () => {
  const { m, repos, state } = model(["spike"]);
  await m.scan(repos);
  let was = m.revision;
  await m.scan(repos);
  assert.equal(m.revision, was);
  state.branches = ["spike", "issue-2"];
  await m.scan(repos);
  assert.notEqual(m.revision, was);
  was = m.revision;
  m.adopt("me/app#spike", { number: 3, title: "Fixes issue-7" });
  assert.notEqual(m.revision, was);
  was = m.revision;
  m.setUsage([{ dir: "/wt/spike", cost: 1 }]);
  assert.notEqual(m.revision, was);
  was = m.revision;
  m.setUsage([{ dir: "/wt/spike", cost: 1 }]);
  assert.equal(m.revision, was);
});

test("stackOrder: each PR after the one it is based on, bottom first", () => {
  const pr = (number, branch, base) => ({ number, branch, base });
  // 42 on 39 on 34 (on main), given shuffled; 50 starts its own chain.
  const stack = stackOrder([
    pr(42, "c", "b"),
    pr(50, "x", "main"),
    pr(34, "a", "main"),
    pr(39, "b", "a"),
  ]);
  assert.deepEqual(
    stack.map((p) => p.number),
    [34, 39, 42, 50],
  );
  // No base known (or none of them): number order, as before.
  assert.deepEqual(
    stackOrder([pr(30, "p"), pr(10, "q")]).map((p) => p.number),
    [10, 30],
  );
  // A cycle has no bottom: it still comes out, by number.
  assert.deepEqual(
    stackOrder([pr(2, "a", "b"), pr(1, "b", "a")]).map((p) => p.number),
    [1, 2],
  );
});

test("WorkModel.stackOf: the stack is in stack order, not number order", async () => {
  const repo = { slug: "me/app", path: "/src/app", name: "app", tracker };
  // 13 is the row's PR (on main); 20 is based on 13, and 12 on 20.
  const prs = {
    "issue-1-b": { number: 13, branch: "issue-1-b", base: "main" },
    "issue-1-20": { number: 20, branch: "issue-1-20", base: "issue-1-b" },
    "issue-1-12": { number: 12, branch: "issue-1-12", base: "issue-1-20" },
  };
  const pr = (p) => ({
    slug: "me/app",
    state: "OPEN",
    draft: false,
    review: "REVIEW_REQUIRED",
    checks: null,
    mergeable: "MERGEABLE",
    ...p,
  });
  const store = new WorkStore({
    sources: {
      repoState: async () => ({
        worktrees: [{ path: "/wt/issue-1", branch: "issue-1-b" }],
        branches: new Map(Object.keys(prs).map((b) => [b, { local: true }])),
        mainBranch: "main",
        linked: [],
      }),
      prDetailsMany: perRef(async (_slug, ref) => {
        const p = Object.values(prs).find((x) => x.branch === ref);
        return p ? pr(p) : null;
      }),
    },
  });
  const m = new WorkModel({ store });
  await m.scan([repo]);
  const t = { ...tracker, linkedPRs: async () => new Map() };
  await store.refresh(new Map([["#1", t]]), { force: true });
  const [, row] = m.view(LIVE, 0, { width: 400 }).rows;
  assert.equal(row.prValue.number, 13);
  assert.deepEqual(
    m.stackOf(row.w).map((p) => p.number),
    [20, 12],
  );
});

test("WorkModel.view and report: a row shows its ticket's other PRs in the repo (a stack)", async () => {
  const repo = { slug: "me/app", path: "/src/app", name: "app", tracker };
  const pr = (number, branch, more = {}) => ({
    slug: "me/app",
    number,
    branch,
    state: "OPEN",
    draft: false,
    review: "REVIEW_REQUIRED",
    checks: null,
    mergeable: "MERGEABLE",
    ...more,
  });
  const prs = {
    "issue-1": pr(12, "issue-1", { state: "MERGED" }),
    "issue-1-b": pr(13, "issue-1-b"),
    "issue-1-c": pr(14, "issue-1-c", { draft: true }),
    "issue-2": pr(20, "issue-2"),
  };
  const store = new WorkStore({
    sources: {
      repoState: async () => ({
        worktrees: [
          { path: "/wt/issue-1", branch: "issue-1-b" },
          { path: "/wt/issue-2", branch: "issue-2" },
        ],
        branches: new Map(Object.keys(prs).map((b) => [b, { local: true }])),
        mainBranch: "main",
        linked: [],
      }),
      prDetailsMany: perRef(async (_slug, ref) => prs[ref] ?? null),
    },
  });
  const m = new WorkModel({ store });
  await m.scan([repo]);
  const t = { ...tracker, linkedPRs: async () => new Map() };
  await store.refresh(
    new Map([
      ["#1", t],
      ["#2", t],
    ]),
    { force: true },
  );
  const view = m.view(LIVE, 0, { width: 400 });
  const [, one] = view.rows;
  const two = view.rows.find((r) => r.w?.path === "/wt/issue-2");
  assert.equal(one.prValue.number, 13);
  assert.deepEqual(
    one.stack.map((p) => p.head),
    ["#12 merged", "#14 draft"],
  );
  // Not on the note line: each is a sub-item after its row, to select.
  assert.equal(one.note, null);
  assert.match(one.tip, /also #12 merged · #14 draft/);
  const subs = view.rows.slice(2, 4);
  assert.deepEqual(
    subs.map((p) => [p.stacked, p.key, p.steps.length, p.dim]),
    [
      [true, "/wt/issue-1#12", 0, true],
      [true, "/wt/issue-1#14", 0, false],
    ],
  );
  // Each shows its place in the stack: #12, #13 (the row's), #14 of three.
  assert.deepEqual(
    subs.map((p) => p.shown),
    ["1/3 #12 merged", "3/3 #14 draft"],
  );
  assert.equal(view.rows[4], two);
  // The keys can pick one.
  const picked = m.view(LIVE, 0, {
    width: 400,
    picked: { path: "/wt/issue-1#14", step: 0 },
  });
  assert.equal(picked.rows[3].selected, true);
  assert.equal(picked.rows[1].selected, false);
  // Another ticket's PRs aren't its stack.
  assert.deepEqual(two.stack, []);
  assert.equal(two.note, null);
  const report = m.report(
    view.rows.filter((r) => !r.stacked),
    LIVE,
    0,
  );
  assert.deepEqual(
    report.rows[1].stack.map((p) => [p.number, p.state]),
    [
      [12, "MERGED"],
      [14, "OPEN"],
    ],
  );
  assert.deepEqual(report.rows[0].stack, []);
});
