// joinWork: workFor's merge rules on plain data.
import assert from "node:assert/strict";
import { test } from "node:test";

const { joinWork, openWork } = await import("../src/work.js");

// A tracker whose keys are "#<n>" in a branch name like "me/issue-<n>".
const tracker = {
  keysIn: (text) => [...text.matchAll(/issue-(\d+)/g)].map((m) => `#${m[1]}`),
};
const repo = { slug: "me/app", path: "/src/app", name: "app", tracker };
const state = (worktrees, branches) => ({
  repo,
  worktrees,
  branches: new Map(branches.map((b) => [b, { local: true }])),
});
const pr = (number, branch, slug = "me/app") => ({
  number,
  branch,
  slug,
  state: "OPEN",
});

test("joinWork: a branch in both the worktree and branch lists is one item", () => {
  const work = joinWork(
    ["#1", "#2"],
    [state([{ path: "/wt/1", branch: "issue-1" }], ["issue-1", "main"]), null],
  );
  assert.deepEqual(work.get("#1"), [
    { repo, branch: "issue-1", worktree: "/wt/1", pr: null },
  ]);
  assert.deepEqual(work.get("#2"), []);
});

test("joinWork: a linked PR already attached by branch is not added again", () => {
  const p = pr(7, "issue-1");
  const work = joinWork(
    ["#1"],
    [state([], ["issue-1"])],
    new Map([["#1", [{ slug: "ME/app", number: 7 }]]]),
    new Map([
      ["me/app#issue-1", p],
      ["ME/app#7", p],
    ]),
    [repo],
  );
  assert.deepEqual(work.get("#1"), [
    { repo, branch: "issue-1", worktree: null, pr: p },
  ]);
});

test("joinWork: a linked PR with no local branch is its own item", () => {
  const p = pr(9, "other-fix", "me/lib");
  const work = joinWork(
    ["#1"],
    [],
    new Map([["#1", [{ slug: "me/lib", number: 9 }]]]),
    new Map([["me/lib#9", p]]),
    [repo],
  );
  assert.deepEqual(work.get("#1"), [
    {
      repo: { path: null, name: "lib", slug: "me/lib" },
      branch: "other-fix",
      worktree: null,
      pr: p,
    },
  ]);
});

test("joinWork: a failed lookup leaves the item without a PR and adds nothing", () => {
  const work = joinWork(
    ["#1"],
    [state([], ["issue-1"])],
    new Map([["#1", [{ slug: "me/app", number: 3 }]]]),
    new Map(),
    [repo],
  );
  assert.deepEqual(work.get("#1"), [
    { repo, branch: "issue-1", worktree: null, pr: null },
  ]);
});

// WorkStore: due/refresh and join on fake sources and a fake clock.
const { WorkStore, PR_MS, ACTIVE_PR_MS, TICKET_MS, RETRY_MS } = await import(
  "../src/work.js"
);

function fakeStore({ prs = {}, linked = {} } = {}) {
  let t = 0;
  const calls = { pr: [], linked: 0, view: 0 };
  const store = new WorkStore({
    now: () => t,
    sources: {
      repoState: async () => ({
        worktrees: [{ path: "/wt/1", branch: "issue-1" }],
        branches: new Map([["issue-1", { local: true }]]),
        mainBranch: "main",
        linked: [],
      }),
      prDetails: async (slug, ref, was) => {
        calls.pr.push([slug, ref, was?.number ?? null]);
        const v = prs[ref];
        if (v instanceof Error) throw v;
        return v ?? null;
      },
    },
  });
  const trk = {
    ...tracker,
    view: async (k) => {
      calls.view++;
      return { key: k };
    },
    linkedPRs: async (ks) => {
      calls.linked++;
      return new Map(ks.flatMap((k) => (linked[k] ? [[k, linked[k]]] : [])));
    },
  };
  const keys = new Map([["#1", trk]]);
  return { store, keys, calls, tick: (ms) => (t += ms) };
}

test("WorkStore: looks up only what is due, by the freshness rules", async () => {
  const open = {
    ...pr(3, "issue-1"),
    checks: "passed",
    mergeable: "MERGEABLE",
  };
  const f = fakeStore({ prs: { "issue-1": open } });
  await f.store.scan([repo]);
  await f.store.refresh(f.keys, { view: true });
  assert.deepEqual(f.calls.pr, [["me/app", "issue-1", null]]);
  assert.equal(f.calls.view, 1);
  f.tick(PR_MS - 1);
  await f.store.refresh(f.keys, { view: true });
  assert.equal(f.calls.pr.length, 1);
  f.tick(2);
  await f.store.refresh(f.keys, { view: true });
  // Passes the last details on (prDetails' carry-over).
  assert.deepEqual(f.calls.pr[1], ["me/app", "issue-1", 3]);
  assert.equal(f.calls.view, 1);
  assert.equal(f.calls.linked, 1);
  f.tick(TICKET_MS);
  await f.store.refresh(f.keys, { view: true });
  assert.equal(f.calls.view, 2);
  assert.equal(f.calls.linked, 2);
  await f.store.refresh(f.keys, { force: true });
  assert.equal(f.calls.pr.length, 4);
});

test("WorkStore: an active PR is due sooner; a failure is retried and keeps the value", async () => {
  const f = fakeStore({
    prs: { "issue-1": { ...pr(3, "issue-1"), checks: "pending" } },
  });
  await f.store.scan([repo]);
  await f.store.refresh(f.keys);
  f.tick(ACTIVE_PR_MS + 1);
  await f.store.refresh(f.keys);
  assert.equal(f.calls.pr.length, 2);
  f.store.sources.prDetails = async () => {
    throw new Error("offline");
  };
  f.tick(ACTIVE_PR_MS + 1);
  await f.store.refresh(f.keys);
  const entry = f.store.prEntry(repo, "issue-1");
  assert.equal(entry.state, "failed");
  assert.equal(entry.value.number, 3);
  assert.equal(f.store.snapshot(["#1"]).get("#1")[0].pr.number, 3);
  f.store.sources.prDetails = async () => pr(3, "issue-1");
  f.tick(RETRY_MS - ACTIVE_PR_MS);
  await f.store.refresh(f.keys);
  assert.equal(f.store.prEntry(repo, "issue-1").state, "failed");
  f.tick(ACTIVE_PR_MS + 1);
  await f.store.refresh(f.keys);
  assert.equal(f.store.prEntry(repo, "issue-1").state, "found");
});

test("WorkStore: a tracker-linked PR joins the worktree with its branch", async () => {
  const linkedPr = { ...pr(9, "issue-1") };
  const f = fakeStore({
    prs: { 9: linkedPr },
    linked: { "#1": [{ slug: "me/app", number: 9 }] },
  });
  await f.store.scan([repo]);
  const told = [];
  await f.store.refresh(f.keys, { onPR: (ref, was) => told.push([ref, was]) });
  assert.deepEqual(told, [
    ["me/app#issue-1", null],
    ["me/app#9", null],
  ]);
  assert.deepEqual(f.store.snapshot(["#1"]).get("#1"), [
    { repo, branch: "issue-1", worktree: "/wt/1", pr: linkedPr },
  ]);
});

test("openWork: only a merged or closed PR ends a work item", () => {
  const item = (state) => ({
    repo,
    branch: "issue-1",
    worktree: null,
    pr: state && { ...pr(1, "issue-1"), state },
  });
  const open = [item(null), item("OPEN")];
  assert.deepEqual(openWork([...open, item("MERGED"), item("CLOSED")]), open);
});

test("openWork besides this item: the ticket stays open while other work remains", () => {
  const self = { path: "/wt/1", repo, branch: "issue-1" };
  const own = { ...pr(1, "issue-1"), state: "MERGED" };
  const here = { repo, branch: "issue-1", worktree: "/wt/1", pr: own };
  const other = { slug: "me/api", path: "/src/api", name: "api", tracker };
  const elsewhere = { slug: "me/app", path: null, name: "app", tracker };
  const otherRepo = {
    repo: other,
    branch: "issue-1",
    worktree: null,
    pr: null,
  };
  const otherMachine = {
    repo: elsewhere,
    branch: "issue-1-b",
    worktree: null,
    pr: { ...pr(2, "issue-1-b"), state: "OPEN" },
  };
  const fork = {
    repo: elsewhere,
    branch: null,
    worktree: null,
    pr: { ...pr(3, "issue-1", "you/app"), state: "OPEN" },
  };
  // This item, also seen as its PR only (linked by the tracker).
  const samePr = {
    repo: elsewhere,
    branch: null,
    worktree: null,
    pr: { ...own, state: "OPEN" }, // a stale lookup
  };
  assert.deepEqual(openWork([here, samePr], self, own), []);
  for (const w of [otherRepo, otherMachine, fork])
    assert.deepEqual(openWork([here, samePr, w], self, own), [w]);
});
