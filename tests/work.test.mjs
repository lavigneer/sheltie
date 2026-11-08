// joinWork: workFor's merge rules on plain data.
import assert from "node:assert/strict";
import { test } from "node:test";

const { joinWork } = await import("../src/work.js");

// A tracker whose keys are "#<n>" in a branch name like "me/issue-<n>".
const tracker = { keysIn: (text) => [...text.matchAll(/issue-(\d+)/g)].map((m) => `#${m[1]}`) };
const repo = { slug: "me/app", path: "/src/app", name: "app", tracker };
const state = (worktrees, branches) => ({
  repo,
  worktrees,
  branches: new Map(branches.map((b) => [b, { local: true }])),
});
const pr = (number, branch, slug = "me/app") => ({ number, branch, slug, state: "OPEN" });

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
    new Map([["me/app#issue-1", p], ["ME/app#7", p]]),
    [repo],
  );
  assert.deepEqual(work.get("#1"), [{ repo, branch: "issue-1", worktree: null, pr: p }]);
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
  assert.deepEqual(work.get("#1"), [{ repo, branch: "issue-1", worktree: null, pr: null }]);
});
