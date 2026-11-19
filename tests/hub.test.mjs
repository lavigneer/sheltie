// A repo's main checkout (its hub) and its worktrees: telling their spaces apart.
import assert from "node:assert/strict";
import { test } from "node:test";

const { fixtureSpaces } = await import("../src/spaces.js");
const { hubExcept, parseWorktrees } = await import("../src/git.js");

const repo = "/ws/app";
const wt = `${repo}/.worktrees/issue-1`;
const agentWt = `${repo}/.claude/worktrees/side`;
const except = hubExcept(repo, [wt, agentWt]);

const space = (id, folder, tab = `t-${id}`) => ({
  id,
  folder,
  tabs: [{ id: tab }],
});

test("parseWorktrees: the main checkout's branch and the others", () => {
  const out = parseWorktrees(
    [
      `worktree ${repo}`,
      "HEAD 1111",
      "branch refs/heads/main",
      "",
      `worktree ${wt}`,
      "HEAD 2222",
      "branch refs/heads/me/issue-1",
      "",
      `worktree ${agentWt}`,
      "HEAD 3333",
      "detached",
      "",
    ].join("\n"),
    repo,
  );
  assert.equal(out.mainBranch, "main");
  assert.deepEqual(out.linked, [
    { path: wt, branch: "me/issue-1" },
    { path: agentWt, branch: null },
  ]);
  const detached = parseWorktrees(`worktree ${repo}\nHEAD 1\ndetached\n`, repo);
  assert.equal(detached.mainBranch, null);
  assert.deepEqual(detached.linked, []);
});

test("parseWorktrees: leaves out prunable worktrees (folder deleted outside git)", () => {
  const out = parseWorktrees(
    [
      `worktree ${repo}`,
      "HEAD 1111",
      "branch refs/heads/main",
      "",
      `worktree ${wt}`,
      "HEAD 2222",
      "branch refs/heads/me/issue-1",
      "prunable gitdir file points to non-existent location",
      "",
      `worktree ${agentWt}`,
      "HEAD 3333",
      "detached",
      "prunable",
      "",
    ].join("\n"),
    repo,
  );
  assert.equal(out.mainBranch, "main");
  assert.deepEqual(out.linked, []);
});

test("hubExcept: the worktree folder and every listed worktree", () => {
  assert.deepEqual(except, [`${repo}/.worktrees`, wt, agentWt]);
});

// Herdr showing these spaces and panes.
const at = (spaces, panes = []) => fixtureSpaces({ spaces, panes });

test("spaceOf: a hub's space is never a worktree's, by folder", () => {
  let live = at([space("w", wt), space("a", agentWt)]);
  assert.equal(
    live.spaceOf(repo, except),
    undefined,
    "worktrees' spaces left out",
  );
  assert.equal(live.spaceOf(wt)?.id, "w");
  live = at([space("w", wt), space("a", agentWt), space("h", repo)]);
  assert.equal(live.spaceOf(repo, except)?.id, "h");
  assert.equal(live.spaceOf(wt)?.id, "w");
  // A space in a subfolder of the main checkout (not a worktree) is the hub's.
  live = at([space("w", wt), space("s", `${repo}/src`)]);
  assert.equal(live.spaceOf(repo, except)?.id, "s");
});

test("spaceOf: by terminal, a space started elsewhere stays there", () => {
  // The hub's space with a terminal in a worktree: not the worktree's.
  let live = at([space("h", repo, "th")], [{ tab: "th", cwd: wt }]);
  assert.equal(live.spaceOf(wt), undefined);
  assert.equal(live.spaceOf(repo, except)?.id, "h");
  // A worktree's space with a terminal in the main checkout: not the hub's.
  live = at([space("w", wt, "tw")], [{ tab: "tw", cwd: repo }]);
  assert.equal(live.spaceOf(repo, except), undefined);
  // A space without a folder goes by its terminals, worktrees left out.
  live = at([space("x", undefined, "tx")], [{ tab: "tx", cwd: wt }]);
  assert.equal(live.spaceOf(wt)?.id, "x");
  assert.equal(live.spaceOf(repo, except), undefined);
  live = at([space("x", undefined, "tx")], [{ tab: "tx", cwd: `${repo}/src` }]);
  assert.equal(live.spaceOf(repo, except)?.id, "x");
});

test("spaceOf: machine spaces never count", () => {
  const live = at([{ ...space("m", repo), machine: "box" }]);
  assert.equal(live.spaceOf(repo, except), undefined);
});
