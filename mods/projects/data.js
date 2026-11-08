// Repos, worktrees and pull requests (git and gh), and how tickets connect to
// them, shared by the tickets popup and the Work sidebar. Ticket details come
// from the tracker in use (tracker.js).

import { exec } from "herdr";
import { C, REPO_FILE, readSettings, repoSettings } from "./config.js";
import {
  NOT_FOUND,
  basename,
  fill,
  firstLine,
  must,
  pool,
  tool,
} from "./lib.js";
import { tracker, trackerOf } from "./tracker.js";

const git = (cwd, ...args) => tool("git", args, { cwd });

// "owner/repo" from a GitHub remote URL, or null.
export function slugOf(url) {
  const m = (url || "")
    .trim()
    .match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

const sameSlug = (a, b) =>
  Boolean(a && b) && a.toLowerCase() === b.toLowerCase();

// --- Repos ------------------------------------------------------------------

// Local repos under the roots (main checkouts): [{ path, name, slug, tracker,
// problem }]. `tracker` is set when the repo's REPO_FILE picks its own
// (config.js repoSettings); `problem` says what's wrong with that file.
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
  return repos.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

async function ownSettings(repoPath) {
  const file = `${repoPath}/${REPO_FILE}`;
  const read = await readSettings(file);
  const { settings, problem } = repoSettings(read.over, file);
  try {
    return {
      tracker: settings ? tracker(settings) : null,
      problem: read.problem ?? problem,
    };
  } catch (e) {
    return { tracker: null, problem: `${file}: ${e.message}` };
  }
}

// Your tickets from every tracker in use: the global one, then each one repos
// pick for themselves. Each ticket carries its `tracker` and `homes`: the repos
// whose own tracker listed it. A repo's tracker that fails leaves its tickets
// out; the global one failing throws.
export async function listTickets(repos) {
  const global = tracker();
  const sources = new Map([[global, []]]);
  for (const r of repos)
    if (r.tracker && r.tracker !== global)
      sources.set(r.tracker, [...(sources.get(r.tracker) ?? []), r]);
  const own = [...sources].slice(1);
  const [first, ...rest] = await Promise.all([
    global.list(),
    ...own.map(([t]) => t.list().catch(() => [])),
  ]);
  const out = new Map();
  [[global, [], first], ...own.map(([t, homes], i) => [t, homes, rest[i]])]
    .forEach(([t, homes, tickets]) => {
      for (const ticket of tickets) {
        const seen = out.get(ticket.key);
        if (seen) seen.homes.push(...homes);
        else out.set(ticket.key, { ...ticket, tracker: t, homes: [...homes] });
      }
    });
  return [...out.values()];
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

// A target ("owner/repo" or a path) -> local repo, or { slug } when not cloned.
export function findRepo(target, repos) {
  if (!target) return null;
  if (target.startsWith("/") || target.startsWith("~"))
    return (
      repos.find((r) => r.path === target) ?? {
        path: target,
        name: basename(target),
        slug: null,
      }
    );
  return (
    repos.find((r) => sameSlug(r.slug, target)) ?? {
      path: null,
      name: target.split("/").pop(),
      slug: target,
    }
  );
}

// A repo's worktrees from `git worktree list --porcelain`: the main checkout's
// branch (null when detached) and every other worktree ({ path, branch },
// branch null when detached).
export function parseWorktrees(porcelain, repoPath) {
  const all = [];
  for (const line of (porcelain || "").split("\n")) {
    if (line.startsWith("worktree "))
      all.push({ path: line.slice(9), branch: null });
    else if (line.startsWith("branch refs/heads/") && all.length)
      all.at(-1).branch = line.slice(18);
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
export async function repoState(repo) {
  const { mainBranch, linked } = await listWorktrees(repo.path);
  const worktrees = linked
    .filter((w) => w.branch)
    .map((w) => ({ path: w.path, branch: w.branch }));
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

// The tracker's key for a branch in `repo`, or null.
export const keyOfBranch = (branch, repo) =>
  trackerOf(repo).keysIn(branch, repo?.slug ?? null)[0] ?? null;

// --- Worktrees --------------------------------------------------------------

// A ticket's branch (C.branch, e.g. "{ref}" or "me/{ref}").
export const branchFor = (ticket) =>
  fill(C.branch, { ref: ticket.ref, key: ticket.key });

// An ad-hoc branch (not tied to a ticket): C.branch with a short kebab-case
// slug of the description as its {ref}, or null when nothing's left of it.
export function adhocBranch(description) {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug ? fill(C.branch, { ref: slug, key: slug }) : null;
}

export const worktreePath = (repo, branch) =>
  `${repo.path}/${C.worktreeDir}/${branch.split("/").pop()}`;

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
  // Keep worktrees out of the main checkout's `git status`.
  const rel = path.slice(repo.path.length + 1);
  if ((await git(repo.path, "check-ignore", "-q", rel)).code !== 0) {
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

// Removes the worktree and deletes the local branch (after assertClean).
// GitHub has already deleted the remote branch.
export async function removeWorktree(repo, path, branch, prHead) {
  await assertClean(path, prHead);
  const rm = await git(repo.path, "worktree", "remove", path);
  if (rm.code !== 0)
    throw new Error(firstLine(rm.stderr) || "git worktree remove failed");
  // -D: a squash or rebase merge leaves the branch "unmerged" to git.
  await git(repo.path, "branch", "-D", branch);
  await git(repo.path, "fetch", "--quiet", "--prune", "origin");
}

// --- Pull requests ----------------------------------------------------------

const OK = ["SUCCESS", "NEUTRAL", "SKIPPED", "COMPLETED"];
const BAD = [
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
];

const MERGE_STATES = ["MERGEABLE", "CONFLICTING"];

// Details for a PR (number or branch) in `slug`, or null when there is none.
// Throws when GitHub can't be asked, so callers can tell "no PR" from "failed".
// `checks`: "passed" | "failed" | "pending", or null when the PR has none
// (CI not started, or never will: GitHub runs no pull_request CI on a PR that
// conflicts with its base). `mergeable`: "MERGEABLE" | "CONFLICTING" |
// "UNKNOWN" (GitHub works it out lazily, so it's UNKNOWN for a little while
// after a push or a change to the base).
export async function prDetails(slug, ref) {
  const r = await tool("gh", [
    "pr",
    "view",
    String(ref),
    "--repo",
    slug,
    "--json",
    "number,url,title,state,isDraft,reviewDecision,statusCheckRollup,headRefName,headRefOid,autoMergeRequest,mergeable",
  ]);
  if (r.code !== 0) {
    const why = firstLine(r.stderr);
    if (NOT_FOUND.test(why)) return null;
    throw new Error(why || `gh pr view ${ref} --repo ${slug} failed`);
  }
  const pr = JSON.parse(r.stdout);
  const results = (pr.statusCheckRollup ?? []).map(
    (c) => c.conclusion || c.state || c.status || "",
  );
  // A result we don't recognise counts as still running, never as passed.
  const checks = !results.length
    ? null
    : results.some((x) => BAD.includes(x))
      ? "failed"
      : results.every((x) => OK.includes(x))
        ? "passed"
        : "pending";
  return {
    slug,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    draft: pr.isDraft,
    review: pr.reviewDecision || null,
    checks,
    branch: pr.headRefName,
    head: pr.headRefOid,
    autoMerge: Boolean(pr.autoMergeRequest),
    mergeable: MERGE_STATES.includes(pr.mergeable) ? pr.mergeable : "UNKNOWN",
  };
}

// Unresolved review threads on an open PR (a number).
export async function unresolvedThreads(slug, number) {
  const [owner, name] = slug.split("/");
  const out = await must(
    "gh",
    [
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${number}`,
      "-f",
      "query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { isResolved } } } } }",
      "--jq",
      "[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length",
    ],
    "gh api graphql",
  );
  return Number(out.trim());
}

export const markReady = (slug, number) =>
  must("gh", ["pr", "ready", String(number), "--repo", slug], "gh pr ready");

// The merge method GitHub's web UI offers you first for this repo.
const mergeMethods = new Map();
async function defaultMergeMethod(slug) {
  if (!mergeMethods.has(slug)) {
    const out = await must(
      "gh",
      [
        "repo",
        "view",
        slug,
        "--json",
        "viewerDefaultMergeMethod",
        "--jq",
        ".viewerDefaultMergeMethod",
      ],
      "gh repo view",
    );
    mergeMethods.set(slug, out.trim().toLowerCase() || "merge");
  }
  return mergeMethods.get(slug);
}

// Merges a PR now, or with `auto` once its requirements (reviews, checks) are
// met, using the web UI's default merge method.
export async function mergePr(slug, number, { auto = false } = {}) {
  const method = await defaultMergeMethod(slug);
  await must(
    "gh",
    [
      "pr",
      "merge",
      String(number),
      "--repo",
      slug,
      `--${method}`,
      ...(auto ? ["--auto"] : []),
    ],
    "gh pr merge",
  );
}

// "#881 draft approved ✓" (or "#881 draft conflicts") and a tone for
// coloring: "bad" | "good" | null.
export function prLabel(pr) {
  if (!pr) return null;
  const parts = [`#${pr.number}`];
  if (pr.state === "MERGED") parts.push("merged");
  else if (pr.state === "CLOSED") parts.push("closed");
  else {
    if (pr.draft) parts.push("draft");
    if (pr.review === "APPROVED") parts.push("approved");
    else if (pr.review === "CHANGES_REQUESTED") parts.push("changes requested");
    else if (!pr.draft && !pr.review) parts.push("no review needed");
    if (pr.checks)
      parts.push({ failed: "✗", pending: "◌", passed: "✓" }[pr.checks]);
  }
  const conflicts = pr.state === "OPEN" && pr.mergeable === "CONFLICTING";
  if (conflicts) parts.push("conflicts");
  const bad =
    conflicts || pr.checks === "failed" || pr.review === "CHANGES_REQUESTED";
  const good =
    pr.state === "MERGED" ||
    (pr.review === "APPROVED" && pr.checks === "passed");
  return { text: parts.join(" "), tone: bad ? "bad" : good ? "good" : null };
}

// --- Putting it together ----------------------------------------------------

// Every piece of work for each ticket (from listTickets), by key: [{ repo,
// branch, worktree, pr }], from local branches/worktrees whose name has the
// key and PRs the ticket's tracker links to it.
export async function workFor(tickets, repos, { prs = true } = {}) {
  const keys = tickets.map((t) => t.key);
  const states = await pool(
    repos
      .filter((r) => r.path)
      .map((repo) => async () => ({ repo, ...(await repoState(repo)) })),
  );
  const work = new Map(keys.map((k) => [k, []]));
  const add = (key, item) => {
    const list = work.get(key);
    if (!list) return;
    const same = list.find(
      (w) =>
        w.repo.slug === item.repo.slug &&
        w.repo.path === item.repo.path &&
        w.branch &&
        w.branch === item.branch,
    );
    if (same)
      Object.assign(
        same,
        Object.fromEntries(Object.entries(item).filter(([, v]) => v != null)),
      );
    else list.push(item);
  };
  for (const s of states.filter(Boolean)) {
    const mentioned = (branch) => trackerOf(s.repo).keysIn(branch, s.repo.slug);
    for (const w of s.worktrees)
      for (const key of mentioned(w.branch))
        add(key, {
          repo: s.repo,
          branch: w.branch,
          worktree: w.path,
          pr: null,
        });
    for (const [name] of s.branches)
      for (const key of mentioned(name))
        add(key, { repo: s.repo, branch: name, worktree: null, pr: null });
  }
  if (!prs) return work;

  // PRs: the branches we found, plus any PR the tracker links to the key.
  const byTracker = new Map();
  for (const t of tickets)
    byTracker.set(t.tracker, [...(byTracker.get(t.tracker) ?? []), t.key]);
  const linked = new Map();
  for (const found of await Promise.all(
    [...byTracker].map(([t, ks]) => t.linkedPRs(ks, repos).catch(() => new Map())),
  ))
    for (const [k, v] of found) linked.set(k, v);
  const lookups = [];
  for (const [key, items] of work) {
    for (const item of items)
      if (item.repo.slug)
        lookups.push({ key, slug: item.repo.slug, ref: item.branch, item });
    for (const p of linked.get(key) ?? [])
      lookups.push({ key, slug: p.slug, ref: p.number });
  }
  // A failed lookup just leaves that item without PR details here.
  const details = await pool(
    lookups.map((l) => () => prDetails(l.slug, l.ref)),
  );
  lookups.forEach((l, i) => {
    const pr = details[i];
    if (!pr) return;
    if (l.item) l.item.pr = pr;
    else if (
      !work
        .get(l.key)
        .some(
          (w) => sameSlug(w.repo.slug, pr.slug) && w.pr?.number === pr.number,
        )
    )
      add(l.key, {
        repo: findRepo(pr.slug, repos),
        branch: pr.branch,
        worktree: null,
        pr,
      });
  });
  return work;
}

// Where new work on a ticket should go: [{ repo, why }] best first (may be
// empty): the repo last used for it, the repos whose own tracker listed it
// (ticket.homes), repoRules matching its component or label,
// what the tracker suggests (GitHub: the issue's repo), repoRules matching its
// project (only when no component/label rule matched), the current repo.
export function suggestRepos(ticket, repos, here, remembered) {
  const out = [];
  const push = (repo, why) => {
    if (
      repo &&
      !out.some(
        (o) =>
          (o.repo.slug && sameSlug(o.repo.slug, repo.slug)) ||
          (o.repo.path && o.repo.path === repo.path),
      )
    )
      out.push({ repo, why });
  };
  if (remembered) push(findRepo(remembered, repos), "last used");
  for (const r of ticket.homes ?? []) push(r, REPO_FILE);
  const has = (list, v) =>
    v != null &&
    list.some((x) => String(x).toLowerCase() === String(v).toLowerCase());
  const specific = C.repoRules.filter(
    (r) =>
      (r.component && has(ticket.components, r.component)) ||
      (r.label && has(ticket.labels, r.label)),
  );
  for (const r of specific)
    push(
      findRepo(r.repo, repos),
      r.component ? `component ${r.component}` : `label ${r.label}`,
    );
  for (const s of (ticket.tracker ?? tracker()).suggest(ticket))
    push(findRepo(s.target, repos), s.why);
  if (!specific.length)
    for (const r of C.repoRules)
      if (
        r.project &&
        !r.component &&
        !r.label &&
        has([ticket.project], r.project)
      )
        push(findRepo(r.repo, repos), `project ${r.project}`);
  if (here)
    push(
      repos.find((r) => r.path === here) ?? {
        path: here,
        name: basename(here),
        slug: null,
      },
      "current repo",
    );
  return out;
}
