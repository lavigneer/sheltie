// git.js's destructive worktree ops against real temp repos: a bare origin and
// a clone of it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { after, before, test } from "node:test";

const { addWorktree, assertClean, removeWorktree } = await import(
  "../src/git.js"
);

const tmp = fs.mkdtempSync(`${os.tmpdir()}/sheltie-git-`);
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
const repo = { path: `${tmp}/app`, name: "app", slug: null };

before(() => {
  git(tmp, "init", "--quiet", "--bare", "-b", "main", "origin.git");
  git(tmp, "clone", "--quiet", `${tmp}/origin.git`, "app");
  git(repo.path, "commit", "--quiet", "--allow-empty", "-m", "init");
  git(repo.path, "push", "--quiet", "origin", "main");
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const rejects = (p, re) => assert.rejects(p, (e) => re.test(e.message));
const branches = () => git(repo.path, "branch", "--format=%(refname:short)");

test("addWorktree: a new branch, kept out of the main checkout's status", async () => {
  const path = await addWorktree(repo, "me/one", { create: true });
  assert.equal(path, `${repo.path}/.worktrees/one`);
  assert.equal(git(path, "branch", "--show-current"), "me/one");
  assert.equal(git(repo.path, "status", "--porcelain"), "");
  await rejects(addWorktree(repo, "me/missing"), /isn't a local branch/);
});

test("assertClean: refuses uncommitted changes and commits not in the PR", async () => {
  const path = await addWorktree(repo, "me/two", { create: true });
  const head = git(path, "rev-parse", "HEAD");
  await assertClean(path, head);
  await assertClean(path, null);
  fs.writeFileSync(`${path}/f`, "x");
  await rejects(assertClean(path, head), /uncommitted changes/);
  git(path, "add", "f");
  git(path, "commit", "--quiet", "-m", "f");
  await rejects(assertClean(path, head), /commits that aren't in the PR/);
  await assertClean(path, git(path, "rev-parse", "HEAD"));
  await rejects(assertClean(`${tmp}/nowhere`, head), /./);
});

test("removeWorktree: removes the worktree and branch, never dirty work", async () => {
  const path = await addWorktree(repo, "me/three", { create: true });
  const head = git(path, "rev-parse", "HEAD");
  fs.writeFileSync(`${path}/f`, "x");
  await rejects(removeWorktree(repo, path, "me/three", head), /uncommitted/);
  assert.ok(fs.existsSync(`${path}/f`), "dirty work left alone");
  fs.rmSync(`${path}/f`);
  await removeWorktree(repo, path, "me/three", head);
  assert.ok(!fs.existsSync(path));
  assert.ok(!branches().split("\n").includes("me/three"));
});
