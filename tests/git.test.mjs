// git.js's destructive worktree ops against real temp repos: a bare origin and
// a clone of it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { after, before, test } from "node:test";

const { addWorktree, assertClean, removeWorktree, touchedRepos } = await import(
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

// Sets the mtime of every file and folder under `dir` back by ten minutes, so
// touchedRepos (a two-minute window) sees the repo as quiet.
function ageTree(dir) {
  const old = new Date(Date.now() - 10 * 60_000);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) ageTree(p);
    fs.utimesSync(p, old, old);
  }
  fs.utimesSync(dir, old, old);
}

test("touchedRepos: a repo whose refs changed is listed; a quiet one is not", async () => {
  const idle = `${tmp}/idle`;
  git(tmp, "init", "--quiet", "-b", "main", "idle");
  git(idle, "commit", "--quiet", "--allow-empty", "-m", "init");
  ageTree(`${idle}/.git`);
  assert.deepEqual(await touchedRepos([idle]), new Set());
  // A branch is a new file under refs/heads, and so touches the repo.
  git(idle, "branch", "fresh");
  assert.deepEqual(await touchedRepos([idle]), new Set([idle]));
  // A path that isn't a repo lists nothing (and is not an error).
  assert.deepEqual(await touchedRepos([`${tmp}/nowhere`]), new Set());
});

test("touchedRepos: writes to objects and logs do not count", async () => {
  const quiet = `${tmp}/quiet`;
  git(tmp, "init", "--quiet", "-b", "main", "quiet");
  git(quiet, "commit", "--quiet", "--allow-empty", "-m", "init");
  ageTree(`${quiet}/.git`);
  // Objects and reflogs change on every commit; repoState reads neither.
  fs.mkdirSync(`${quiet}/.git/objects/zz`, { recursive: true });
  fs.writeFileSync(`${quiet}/.git/objects/zz/new`, "");
  fs.writeFileSync(`${quiet}/.git/logs/HEAD`, "x");
  assert.deepEqual(await touchedRepos([quiet]), new Set());
});
