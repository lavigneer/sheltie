// The git reads at scale, against real git (#368): REPOS temp repos (each a
// clone of its own bare origin) with WORKTREES worktrees each, through
// localRepos, listWorktrees, repoState, touchedRepos and the Work scan.
// Counts the git processes each phase starts (lib.js callCounts), which must
// grow with the repos and not with their worktrees, and logs each phase's
// wall time.
//
// Building the repos takes a while, so this runs only with SHELTIE_SCALE=1:
// `npm run test:scale` (CI runs it as its own step). Sizes:
// SHELTIE_SCALE_REPOS (default 20) and SHELTIE_SCALE_WORKTREES (default 25).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const ON = process.env.SHELTIE_SCALE === "1";
const REPOS = Number(process.env.SHELTIE_SCALE_REPOS ?? 20);
const WORKTREES = Number(process.env.SHELTIE_SCALE_WORKTREES ?? 25);
const skip = ON ? false : "set SHELTIE_SCALE=1 (npm run test:scale)";

const { C } = await import("../src/config.js");
const { callCounts, callsSince } = await import("../src/lib.js");
const { listWorktrees, localRepos, repoState, touchedRepos } = await import(
  "../src/git.js"
);
const { WorkStore } = await import("../src/work.js");

const tmp = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/sheltie-gscale-`));
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...args) =>
  execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

// Two workspaces of REPOS repos: `one` with a single worktree each, `many`
// with WORKTREES each, so a count that grows with worktrees shows as a
// difference between them.
/** @param {string} ws @param {number} worktrees */
function build(ws, worktrees) {
  fs.mkdirSync(`${tmp}/${ws}/remotes`, { recursive: true });
  for (let r = 0; r < REPOS; r++) {
    const origin = `${tmp}/${ws}/remotes/r${r}.git`;
    const repo = `${tmp}/${ws}/src/r${r}`;
    git(tmp, "init", "--quiet", "--bare", "-b", "main", origin);
    git(tmp, "clone", "--quiet", origin, repo);
    git(repo, "commit", "--quiet", "--allow-empty", "-m", "init");
    git(repo, "push", "--quiet", "origin", "main");
    git(repo, "remote", "set-url", "origin", `https://github.com/me/r${r}.git`);
    for (let w = 0; w < worktrees; w++)
      git(
        repo,
        "worktree",
        "add",
        "--quiet",
        "-b",
        `issue-${w}`,
        `${repo}/.worktrees/issue-${w}`,
      );
  }
}

// Sets every file under each repo's .git back an hour, so touchedRepos (which
// looks at the last 2 minutes) finds none of them touched.
/** @param {string} dir */
function backdate(dir) {
  const old = new Date(Date.now() - 3_600_000);
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true }))
    fs.utimesSync(path.join(e.parentPath, e.name), old, old);
  fs.utimesSync(dir, old, old);
}

/** @type {Record<string, Record<string, number>>} */
const timings = { one: {}, many: {} };
/** @type {Record<string, Record<string, number>>} */
const gitCalls = { one: {}, many: {} };

// Runs f, recording its git processes and wall time as `phase` of `ws`.
/** @template T @param {string} ws @param {string} phase @param {() => Promise<T>} f @returns {Promise<T>} */
async function measure(ws, phase, f) {
  const before = callCounts();
  const t = performance.now();
  const out = await f();
  timings[ws][phase] = performance.now() - t;
  gitCalls[ws][phase] = callsSince(before).spawns.git ?? 0;
  return out;
}

const was = { roots: C.roots, depth: C.depth };
before(() => {
  if (!ON) return;
  const t = performance.now();
  build("one", 1);
  build("many", WORKTREES);
  console.log(
    `  built ${REPOS} repos x 1 and x ${WORKTREES} worktrees: ${((performance.now() - t) / 1000).toFixed(1)} s`,
  );
});
after(() => {
  C.roots = was.roots;
  C.depth = was.depth;
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!ON) return;
  console.log("  phase            git(x1) git(xN)    ms(x1)    ms(xN)");
  for (const phase of Object.keys(timings.many))
    console.log(
      `  ${phase.padEnd(16)} ${String(gitCalls.one[phase]).padStart(7)} ${String(gitCalls.many[phase]).padStart(7)} ${timings.one[phase].toFixed(0).padStart(9)} ${timings.many[phase].toFixed(0).padStart(9)}`,
    );
});

/** @param {string} ws */
async function phases(ws) {
  C.roots = [`${tmp}/${ws}/src`];
  C.depth = 1;
  const repos = await measure(ws, "localRepos", () => localRepos());
  assert.equal(repos.length, REPOS);
  assert.ok(repos.every((r) => r.slug?.startsWith("me/r")));
  const lists = await measure(ws, "listWorktrees", () =>
    Promise.all(repos.map((r) => listWorktrees(r.path))),
  );
  const states = await measure(ws, "repoState", () =>
    Promise.all(repos.map((r) => repoState(r))),
  );
  const paths = repos.map((r) => r.path);
  const touched = await measure(ws, "touchedRepos", () => touchedRepos(paths));
  assert.equal(touched?.size, REPOS, "just built: every repo touched");

  const store = new WorkStore({
    sources: {
      repoState,
      touched: touchedRepos,
      prDetailsMany: async () => new Map(),
    },
  });
  await measure(ws, "scan (first)", () => store.scan(repos));
  backdate(`${tmp}/${ws}/src`);
  await measure(ws, "scan (quiet)", () => store.scan(repos));
  // One repo changes: only it is read again.
  git(repos[0].path, "branch", "issue-new");
  await measure(ws, "scan (one)", () => store.scan(repos));
  return { repos, lists, states, store };
}

test("git at scale: each phase's git processes grow with the repos, not their worktrees", {
  skip,
}, async () => {
  const one = await phases("one");
  const many = await phases("many");
  // What git found: every worktree, with its branch.
  assert.ok(one.lists.every((l) => l.linked.length === 1));
  assert.ok(many.lists.every((l) => l.linked.length === WORKTREES));
  assert.ok(many.states.every((s) => s.worktrees.length === WORKTREES));
  assert.ok(many.states.every((s) => s.branches.size >= WORKTREES + 1));
  assert.equal(
    many.store.states
      .find((s) => s?.repo.path === many.repos[0].path)
      ?.branches.has("issue-new"),
    true,
    "the changed repo was read again",
  );
  // The same number of git processes with 1 or WORKTREES worktrees a repo...
  assert.deepEqual(gitCalls.many, gitCalls.one);
  // ...and a fixed few per repo read: none for the quiet scan, one repo's
  // worth for the scan after one changed.
  const c = gitCalls.many;
  assert.equal(c.localRepos, 2 * REPOS, "rev-parse and config per repo");
  assert.equal(c.listWorktrees, REPOS);
  assert.equal(c.repoState, 2 * REPOS, "worktree list and for-each-ref");
  assert.equal(c.touchedRepos, 0, "two finds, no git");
  assert.equal(c["scan (first)"], 2 * REPOS);
  assert.equal(c["scan (quiet)"], 0);
  assert.equal(c["scan (one)"], 2);
});
