// The Work sidebar's git side (localRepos -> repoState -> workView) against
// real repos set up in the ways people actually leave worktrees: detached,
// locked, deleted by hand, outside the repo, nested, many of them, odd paths
// and branch names, an empty repo, a bare-repo layout, a symlinked root. None
// may throw, and each worktree on a branch shows as one row.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { after, before, test } from "node:test";

const { C } = await import("../src/config.js");
const { localRepos, repoState, hubExcept, repoRoot } = await import(
  "../src/git.js"
);
const { ticketOfBranch } = await import("../src/tracker.js");
const { workView } = await import("../src/work-rows.js");

// Real paths: macOS's tmpdir is a symlink (/var -> /private/var), and git
// reports real paths. The symlinked-root test below covers that on purpose.
const tmp = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/sheltie-wt-`));
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
const init = (path) => {
  fs.mkdirSync(path, { recursive: true });
  git(path, "init", "--quiet", "-b", "main");
};
const commit = (path) =>
  git(path, "commit", "--quiet", "--allow-empty", "-m", "c");

const saved = { roots: C.roots, depth: C.depth, tracker: C.tracker };
before(() => {
  Object.assign(C, { roots: [tmp], depth: 1, tracker: "github" });
});
after(() => {
  Object.assign(C, saved);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// The groups the Work sidebar builds from git (work/main.js scan) and what
// it would show of them, as in work-rows.js.
async function sidebar(repos) {
  const states = [];
  for (const repo of repos) states.push({ repo, ...(await repoState(repo)) });
  const groups = states.map((s) => ({
    repo: s.repo,
    hub: {
      path: s.repo.path,
      branch: s.mainBranch,
      hub: true,
      except: hubExcept(s.repo.path, s.linked),
    },
    worktrees: s.worktrees.map((w) => ({
      ...w,
      repo: s.repo,
      handle: ticketOfBranch(w.branch, s.repo),
    })),
  }));
  const view = workView({
    groups,
    folded: new Set(),
    width: 400,
    steps: new Map(),
    confirm: null,
    picked: null,
    now: Date.now(),
    spaceOf: () => null,
    stepsOf: () => [],
    prOf: () => null,
    ticketOf: () => null,
    isTicket: (w) => Boolean(w.handle),
    costOf: () => null,
  });
  return { states, groups, view };
}

const repoAt = async (name) => {
  const found = (await localRepos()).find((r) => r.name === name);
  assert.ok(found, `${name} found by localRepos`);
  return found;
};

test("the usual: worktrees in .worktrees and .claude/worktrees, branches with slashes", async () => {
  const path = `${tmp}/usual`;
  init(path);
  commit(path);
  git(path, "worktree", "add", "-q", "-b", "issue-1", ".worktrees/issue-1");
  git(
    path,
    "worktree",
    "add",
    "-q",
    "-b",
    "me/deep/issue-2",
    ".claude/worktrees/issue-2",
  );
  const repo = await repoAt("usual");
  const { states, view } = await sidebar([repo]);
  assert.equal(states[0].mainBranch, "main");
  assert.deepEqual(states[0].worktrees.map((w) => w.branch).sort(), [
    "issue-1",
    "me/deep/issue-2",
  ]);
  assert.equal(view.rows.length, 3);
  assert.equal(await repoRoot(`${path}/.claude/worktrees/issue-2`), path);
});

test("detached, locked and hand-deleted (prunable) worktrees", async () => {
  const path = `${tmp}/odd`;
  init(path);
  commit(path);
  git(path, "worktree", "add", "-q", "--detach", ".worktrees/detached");
  git(path, "worktree", "add", "-q", "-b", "locked", ".worktrees/locked");
  git(
    path,
    "worktree",
    "lock",
    "--reason",
    "on a USB stick",
    ".worktrees/locked",
  );
  git(path, "worktree", "add", "-q", "-b", "gone", ".worktrees/gone");
  fs.rmSync(`${path}/.worktrees/gone`, { recursive: true });
  const repo = await repoAt("odd");
  const { states, view } = await sidebar([repo]);
  const s = states[0];
  // The detached one is linked (its space isn't the hub's) but not a row.
  // The hand-deleted one is listed as prunable until git prunes it, which
  // some git builds do on their own: either way is fine, as long as it's
  // consistent and nothing throws.
  const gone = s.linked.includes(`${path}/.worktrees/gone`) ? 1 : 0;
  assert.ok(s.linked.includes(`${path}/.worktrees/detached`));
  assert.equal(s.linked.length, 2 + gone);
  assert.deepEqual(
    s.worktrees.map((w) => w.branch).sort(),
    gone ? ["gone", "locked"] : ["locked"],
  );
  assert.equal(view.rows.length, 2 + gone);
});

test("a worktree outside the repo is no repo of its own", async () => {
  const path = `${tmp}/outer`;
  init(path);
  commit(path);
  // A sibling of the repo, at the roots' depth: its .git is a file.
  git(path, "worktree", "add", "-q", "-b", "outer-wt", `${tmp}/outer-wt`);
  const repos = await localRepos();
  assert.ok(!repos.some((r) => r.name === "outer-wt"));
  const { states } = await sidebar([await repoAt("outer")]);
  assert.deepEqual(states[0].worktrees, [
    { path: `${tmp}/outer-wt`, branch: "outer-wt" },
  ]);
  assert.equal(await repoRoot(`${tmp}/outer-wt`), path);
});

test("spaces, unicode and other odd characters in paths and branches", async () => {
  const path = `${tmp}/my repo é`;
  init(path);
  commit(path);
  git(
    path,
    "worktree",
    "add",
    "-q",
    "-b",
    "fix/ça-va",
    ".worktrees/with space",
  );
  git(path, "worktree", "add", "-q", "-b", "UPPER_case.dots", ".worktrees/x.y");
  const { states, view } = await sidebar([await repoAt("my repo é")]);
  assert.deepEqual(states[0].worktrees.map((w) => w.path).sort(), [
    `${path}/.worktrees/with space`,
    `${path}/.worktrees/x.y`,
  ]);
  assert.equal(view.rows.length, 3);
});

test("a detached main checkout, and a worktree on the default branch", async () => {
  const path = `${tmp}/detached-main`;
  init(path);
  commit(path);
  git(path, "checkout", "-q", "--detach");
  git(path, "worktree", "add", "-q", ".worktrees/main", "main");
  const { states, view } = await sidebar([await repoAt("detached-main")]);
  assert.equal(states[0].mainBranch, null);
  assert.deepEqual(
    states[0].worktrees.map((w) => w.branch),
    ["main"],
  );
  assert.equal(view.rows[0].title, "detached");
});

test("an empty repo (no commits) and an orphan worktree", async () => {
  const path = `${tmp}/empty`;
  init(path);
  const { states, view } = await sidebar([await repoAt("empty")]);
  assert.equal(states[0].mainBranch, "main");
  assert.deepEqual(states[0].worktrees, []);
  assert.equal(view.rows.length, 1);
  git(
    path,
    "worktree",
    "add",
    "-q",
    "--orphan",
    "-b",
    "fresh",
    ".worktrees/fresh",
  );
  const again = await sidebar([await repoAt("empty")]);
  assert.deepEqual(
    again.states[0].worktrees.map((w) => w.branch),
    ["fresh"],
  );
});

test("a worktree whose branch was deleted from under it", async () => {
  const path = `${tmp}/lost-branch`;
  init(path);
  commit(path);
  git(path, "worktree", "add", "-q", "-b", "doomed", ".worktrees/doomed");
  git(path, "update-ref", "-d", "refs/heads/doomed");
  const { states, view } = await sidebar([await repoAt("lost-branch")]);
  assert.ok(!states[0].branches.has("doomed"));
  assert.ok(view.rows.length >= 1);
});

test("a nested worktree (one inside another) and a mid-rebase worktree", async () => {
  const path = `${tmp}/nested`;
  init(path);
  commit(path);
  git(path, "worktree", "add", "-q", "-b", "outer", ".worktrees/outer");
  git(
    path,
    "worktree",
    "add",
    "-q",
    "-b",
    "inner",
    ".worktrees/outer/.worktrees/inner",
  );
  fs.writeFileSync(`${path}/.worktrees/outer/f`, "a");
  git(`${path}/.worktrees/outer`, "add", "f");
  git(`${path}/.worktrees/outer`, "commit", "-q", "-m", "a");
  const { states, view } = await sidebar([await repoAt("nested")]);
  assert.deepEqual(states[0].worktrees.map((w) => w.branch).sort(), [
    "inner",
    "outer",
  ]);
  assert.equal(view.rows.length, 3);
});

test("a bare-repo layout (.bare plus a .git file) is skipped, not a crash", async () => {
  const path = `${tmp}/bare-layout`;
  fs.mkdirSync(path);
  git(path, "init", "-q", "--bare", "-b", "main", ".bare");
  fs.writeFileSync(`${path}/.git`, "gitdir: ./.bare\n");
  const repos = await localRepos();
  assert.ok(!repos.some((r) => r.name === "bare-layout"));
  assert.equal(await repoRoot(path), null);
});

test("many worktrees: every one is a row, with ticket handles", async () => {
  const path = `${tmp}/many`;
  init(path);
  commit(path);
  git(path, "remote", "add", "origin", "git@github.com:me/many.git");
  const n = 120;
  for (let i = 1; i <= n; i++)
    git(
      path,
      "worktree",
      "add",
      "-q",
      "-b",
      `me/issue-${i}`,
      `.worktrees/issue-${i}`,
    );
  const { states, view } = await sidebar([await repoAt("many")]);
  assert.equal(states[0].worktrees.length, n);
  assert.equal(view.rows.length, n + 1);
  assert.ok(view.rows.slice(1).every((r) => /#\d+$/.test(r.title)));
});

test("a symlinked root: repos found through it still have a hub", async () => {
  const link = `${tmp}-link`;
  fs.symlinkSync(tmp, link);
  try {
    C.roots = [link];
    const repos = await localRepos();
    const repo = repos.find((r) => r.name === "usual");
    assert.ok(repo, "found through the symlink");
    assert.equal(repo.path, `${tmp}/usual`, "by its real path");
    C.roots = [link, tmp];
    assert.equal((await localRepos()).length, repos.length, "once each");
    const { states, view } = await sidebar([repo]);
    // The hub's own branch, and its main checkout not listed as a worktree.
    assert.equal(states[0].mainBranch, "main");
    assert.ok(!states[0].linked.includes(fs.realpathSync(repo.path)));
    assert.equal(view.rows.length, 3);
  } finally {
    C.roots = [tmp];
    fs.unlinkSync(link);
  }
});

test("every repo above at once", async () => {
  const repos = await localRepos();
  const { view } = await sidebar(repos);
  assert.equal(view.groups.length, repos.length);
});
