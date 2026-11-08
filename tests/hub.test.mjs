// A repo's main checkout (its hub) and its worktrees: telling their spaces apart.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { live } from "./herdr-stub.mjs";

const { spaceFor } = await import("../src/lib.js");
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

afterEach(() => {
  live.spaces = [];
  live.panes = [];
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

test("hubExcept: the worktree folder and every listed worktree", () => {
  assert.deepEqual(except, [`${repo}/.worktrees`, wt, agentWt]);
});

test("spaceFor: a hub's space is never a worktree's, by folder", () => {
  live.spaces = [space("w", wt), space("a", agentWt)];
  assert.equal(spaceFor(repo, except), undefined, "worktrees' spaces left out");
  assert.equal(spaceFor(wt)?.id, "w");
  live.spaces.push(space("h", repo));
  assert.equal(spaceFor(repo, except)?.id, "h");
  assert.equal(spaceFor(wt)?.id, "w");
  // A space in a subfolder of the main checkout (not a worktree) is the hub's.
  live.spaces = [space("w", wt), space("s", `${repo}/src`)];
  assert.equal(spaceFor(repo, except)?.id, "s");
});

test("spaceFor: by terminal, a space started elsewhere stays there", () => {
  // The hub's space with a terminal in a worktree: not the worktree's.
  live.spaces = [space("h", repo, "th")];
  live.panes = [{ tab: "th", cwd: wt }];
  assert.equal(spaceFor(wt), undefined);
  assert.equal(spaceFor(repo, except)?.id, "h");
  // A worktree's space with a terminal in the main checkout: not the hub's.
  live.spaces = [space("w", wt, "tw")];
  live.panes = [{ tab: "tw", cwd: repo }];
  assert.equal(spaceFor(repo, except), undefined);
  // A space without a folder goes by its terminals, worktrees left out.
  live.spaces = [space("x", undefined, "tx")];
  live.panes = [{ tab: "tx", cwd: wt }];
  assert.equal(spaceFor(wt)?.id, "x");
  assert.equal(spaceFor(repo, except), undefined);
  live.panes = [{ tab: "tx", cwd: `${repo}/src` }];
  assert.equal(spaceFor(repo, except)?.id, "x");
});

test("spaceFor: machine spaces never count", () => {
  live.spaces = [{ ...space("m", repo), machine: "box" }];
  assert.equal(spaceFor(repo, except), undefined);
});
