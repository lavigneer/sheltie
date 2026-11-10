// Repos, worktrees and branches (git), shared by the mods. Ticket keys in
// branch names come from the tracker in use (tracker.js).

import { exec } from "herdr";
import {
  C,
  REPO_FILE,
  readSettings,
  repoSettings,
  settingsOf,
} from "./config.js";
import { basename, fill, firstLine, must, pool, tool } from "./lib.js";
import { tracker } from "./tracker.js";

const git = (cwd, ...args) => tool("git", args, { cwd });

// "owner/repo" from a GitHub remote URL, or null.
export function slugOf(url) {
  const m = (url || "")
    .trim()
    .match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m && !/\.git$/i.test(m[2]) ? `${m[1]}/${m[2]}` : null;
}

/** @param {string | null | undefined} a @param {string | null | undefined} b */
export const sameSlug = (a, b) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

// --- Repos ------------------------------------------------------------------

// Local repos under the roots (main checkouts): [{ path, name, slug, settings,
// tracker, problem }]. `settings` (see config.js settingsOf) and `tracker` are
// set when the repo's REPO_FILE sets any of REPO_SETTINGS; `problem` says
// what's wrong with that file.
/** @returns {Promise<(import("./types.js").Repo & { path: string })[]>} */
export async function localRepos() {
  const paths = new Set();
  for (const root of C.roots) {
    const depth = String(C.depth + 1);
    const r = await exec("find", [
      root,
      "-mindepth",
      depth,
      "-maxdepth",
      depth,
      "-name",
      ".git",
      // A directory: a linked worktree's .git is a file, and it is no repo of
      // its own (it shows as a worktree of its main checkout).
      "-type",
      "d",
      "-prune",
    ]).catch(() => null);
    for (const line of r?.stdout.split("\n") ?? [])
      if (line.endsWith("/.git")) paths.add(line.slice(0, -5));
  }
  const repos = await pool(
    [...paths].map((path) => async () => {
      const r = await git(path, "config", "--get", "remote.origin.url").catch(
        () => null,
      );
      return {
        path,
        name: basename(path),
        slug: r?.code === 0 ? slugOf(r.stdout) : null,
        ...(await ownSettings(path)),
      };
    }),
  );
  return repos
    .filter((r) => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function ownSettings(repoPath) {
  const file = `${repoPath}/${REPO_FILE}`;
  const read = await readSettings(file);
  const { settings, problem } = repoSettings(read.over, file);
  try {
    return {
      settings,
      tracker: settings ? tracker(settings) : null,
      problem: read.problem ?? problem,
    };
  } catch (e) {
    return { settings: null, tracker: null, problem: `${file}: ${e.message}` };
  }
}

// The main checkout of the repo containing `dir` (also from inside a worktree), or null.
export async function repoRoot(dir) {
  if (!dir) return null;
  const r = await git(
    dir,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ).catch(() => null);
  const common = r?.code === 0 ? r.stdout.trim() : "";
  return common.endsWith("/.git") ? common.slice(0, -5) : null;
}

// A repo's worktrees from `git worktree list --porcelain`: the main checkout's
// branch (null when detached) and every other worktree ({ path, branch },
// branch null when detached).
/** @param {string} porcelain @param {string} repoPath */
export function parseWorktrees(porcelain, repoPath) {
  /** @type {{ path: string, branch: string | null }[]} */
  const all = [];
  for (const line of (porcelain || "").split("\n")) {
    if (line.startsWith("worktree "))
      all.push({ path: line.slice(9), branch: null });
    else if (line.startsWith("branch refs/heads/") && all.length)
      all[all.length - 1].branch = line.slice(18);
  }
  return {
    mainBranch: all.find((w) => w.path === repoPath)?.branch ?? null,
    linked: all.filter((w) => w.path !== repoPath),
  };
}

export async function listWorktrees(repoPath) {
  const r = await git(repoPath, "worktree", "list", "--porcelain").catch(
    () => null,
  );
  return parseWorktrees(r?.code === 0 ? r.stdout : "", repoPath);
}

// What a repo's main checkout (its hub) leaves out when matching its space:
// the worktree folder and every listed worktree (`linked` paths), which live
// inside it (e.g. <repo>/.worktrees/x, <repo>/.claude/worktrees/y).
export const hubExcept = (repoPath, linked) => [
  `${repoPath}/${C.worktreeDir}`,
  ...linked,
];

// Worktrees (not the main checkout, and on a branch) and branches of a repo,
// plus the main checkout's branch (mainBranch; null when detached) and every
// linked worktree's path (linked; detached ones too).
/**
 * @typedef {object} RepoState
 * @property {{ path: string, branch: string }[]} worktrees
 * @property {Map<string, { local?: boolean, remote?: boolean }>} branches
 * @property {string | null} mainBranch
 * @property {string[]} linked
 */
/** @param {import("./types.js").Repo & { path: string }} repo @returns {Promise<RepoState>} */
export async function repoState(repo) {
  const { mainBranch, linked } = await listWorktrees(repo.path);
  const worktrees = linked.flatMap((w) =>
    w.branch ? [{ path: w.path, branch: w.branch }] : [],
  );
  const branches = new Map(); // name -> { local, remote }
  const refs = await git(
    repo.path,
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes/origin",
  ).catch(() => null);
  for (const ref of refs?.stdout.split("\n") ?? []) {
    let name, kind;
    if (ref.startsWith("refs/heads/")) [name, kind] = [ref.slice(11), "local"];
    else if (
      ref.startsWith("refs/remotes/origin/") &&
      ref !== "refs/remotes/origin/HEAD"
    )
      [name, kind] = [ref.slice(20), "remote"];
    else continue;
    branches.set(name, { ...(branches.get(name) ?? {}), [kind]: true });
  }
  return {
    worktrees,
    branches,
    mainBranch,
    linked: linked.map((w) => w.path),
  };
}

// --- Worktrees --------------------------------------------------------------

// A ticket's branch in `repo` (its `branch` setting, e.g. "{ref}" or "me/{ref}").
export const branchFor = (ticket, repo) =>
  fill(settingsOf(repo).branch, { ref: ticket.ref, key: ticket.key });

// An ad-hoc branch (not tied to a ticket) in `repo`: its `branch` setting with a short kebab-case
// slug of the description as its {ref}, or null when nothing's left of it.
export function adhocBranch(description, repo) {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug ? fill(settingsOf(repo).branch, { ref: slug, key: slug }) : null;
}

// Where `branch`'s worktree goes: <repo>/<worktreeDir>/<its last part>. A
// branch whose last part would step out of worktreeDir ("", ".", "..") throws.
export function worktreePath(repo, branch) {
  const name = branch.split("/").pop() ?? "";
  if (name === "" || name === "." || name === "..")
    throw new Error(`no worktree directory for branch "${branch}"`);
  return `${repo.path}/${C.worktreeDir}/${name}`;
}

// Keeps worktrees (`path` is one) out of the main checkout's `git status`.
async function excludeWorktrees(repo, path) {
  const rel = path.slice(repo.path.length + 1);
  if ((await git(repo.path, "check-ignore", "-q", rel)).code === 0) return;
  const common = (
    await git(
      repo.path,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    )
  ).stdout.trim();
  await exec("sh", [
    "-c",
    'mkdir -p "$1" && printf "%s\\n" "$2" >> "$1/exclude"',
    "sh",
    `${common}/info`,
    `/${C.worktreeDir}/`,
  ]);
}

// Where a review of PR #`number` is checked out: <repo>/<worktreeDir>/review-<number>.
export const reviewPath = (repo, number) =>
  `${repo.path}/${C.worktreeDir}/review-${number}`;

// Checks out PR #`number` (`gh pr checkout`, so forks work too) in its review
// worktree (reviewPath) and returns { path, existing }: an existing one is
// left as it is.
export async function addReviewWorktree(repo, number) {
  const path = reviewPath(repo, number);
  const { linked } = await listWorktrees(repo.path);
  if (linked.some((w) => w.path === path)) return { path, existing: true };
  await excludeWorktrees(repo, path);
  const r = await git(repo.path, "worktree", "add", "--detach", path);
  if (r.code !== 0)
    throw new Error(firstLine(r.stderr) || "git worktree add failed");
  const co = await tool("gh", ["pr", "checkout", String(number)], {
    cwd: path,
  });
  if (co.code !== 0) {
    await git(repo.path, "worktree", "remove", "--force", path);
    throw new Error(firstLine(co.stderr) || `gh pr checkout ${number} failed`);
  }
  return { path, existing: false };
}

// `repo`'s review worktrees (see reviewPath): { number, path, branch }.
export async function reviewWorktrees(repo) {
  const prefix = `${repo.path}/${C.worktreeDir}/review-`;
  const { linked } = await listWorktrees(repo.path);
  return linked
    .filter((w) => w.path.startsWith(prefix))
    .map((w) => ({ ...w, number: Number(w.path.slice(prefix.length)) }))
    .filter((w) => Number.isInteger(w.number) && w.number > 0);
}

// Adds a worktree for `branch` and returns its path. Where the branch comes from:
//   1. a local branch of that name;
//   2. origin's branch of that name (tracked);
//   3. with `pr` (a PR number): the PR's head, refs/pull/<pr>/head — for a PR
//      from a fork, or one whose branch was deleted after merging;
//   4. with `create`: a new branch from origin's default branch (new work).
// Anything else is an error: an existing PR or branch never silently becomes an
// empty look-alike branch cut from main.
export async function addWorktree(
  repo,
  branch,
  { create = false, pr = null } = {},
) {
  const path = worktreePath(repo, branch);
  await excludeWorktrees(repo, path);
  // Best effort: offline, local branches still work and new ones start from
  // the last fetched default branch.
  await git(repo.path, "fetch", "--quiet", "origin");
  const has = async (ref) =>
    (await git(repo.path, "show-ref", "--verify", "--quiet", ref)).code === 0;
  const add = (...args) => git(repo.path, "worktree", "add", ...args);
  let r;
  if (await has(`refs/heads/${branch}`)) r = await add(path, branch);
  else if (await has(`refs/remotes/origin/${branch}`))
    r = await add("--track", "-b", branch, path, `origin/${branch}`);
  else if (pr) {
    const f = await git(
      repo.path,
      "fetch",
      "--quiet",
      "origin",
      `pull/${pr}/head:refs/heads/${branch}`,
    );
    if (f.code !== 0)
      throw new Error(
        `${branch} isn't on origin and PR #${pr}'s head couldn't be fetched: ${firstLine(f.stderr)}`,
      );
    r = await add(path, branch);
  } else if (create) {
    const head = await git(
      repo.path,
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    );
    r = await add(
      "--no-track",
      "-b",
      branch,
      path,
      head.code === 0 ? head.stdout.trim() : "HEAD",
    );
  } else throw new Error(`${branch} isn't a local branch or on origin`);
  if (r.code !== 0)
    throw new Error(firstLine(r.stderr) || "git worktree add failed");
  return path;
}

// Clones a repo that isn't local yet into the first root.
export async function cloneRepo(slug) {
  const path = `${C.roots[0]}/${slug.split("/").pop()}`;
  await must("gh", ["repo", "clone", slug, path], `gh repo clone ${slug}`);
  return { path, name: basename(path), slug };
}

// After a merge: refuses if the worktree has uncommitted changes or commits
// that aren't in the PR (its head is `prHead`), so nothing unpushed is lost.
export async function assertClean(path, prHead) {
  const status = await git(path, "status", "--porcelain");
  if (status.code !== 0)
    throw new Error(firstLine(status.stderr) || `can't read ${path}`);
  if (status.stdout.trim())
    throw new Error(`${basename(path)} has uncommitted changes`);
  const head = (await git(path, "rev-parse", "HEAD")).stdout.trim();
  if (prHead && head !== prHead)
    throw new Error(
      `${basename(path)} has commits that aren't in the PR (push or drop them first)`,
    );
}

// Removes the worktree and deletes its local branch, if any (after
// assertClean). GitHub has already deleted the remote branch.
export async function removeWorktree(repo, path, branch, prHead) {
  await assertClean(path, prHead);
  const rm = await git(repo.path, "worktree", "remove", path);
  if (rm.code !== 0)
    throw new Error(firstLine(rm.stderr) || "git worktree remove failed");
  // -D: a squash or rebase merge leaves the branch "unmerged" to git.
  if (branch) await git(repo.path, "branch", "-D", branch);
  await git(repo.path, "fetch", "--quiet", "--prune", "origin");
}
