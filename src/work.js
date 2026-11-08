// How tickets connect to repos, branches, worktrees and PRs, shared by the
// tickets popup and the Work sidebar. Ticket details come from the tracker in
// use (tracker.js).

import { C, REPO_FILE } from "./config.js";
import { repoState, sameSlug } from "./git.js";
import { basename, pool } from "./lib.js";
import { prDetails } from "./prs.js";
import { tracker, trackerOf } from "./tracker.js";

/** @typedef {import("./types.js").Ticket} Ticket */
/** @typedef {import("./types.js").Repo} Repo */
/** @typedef {import("./types.js").PR} PR */
/** @typedef {import("./types.js").PRRef} PRRef */
/** @typedef {import("./types.js").WorkItem} WorkItem */

// Your tickets from every tracker in use: the global one, then each one repos
// pick for themselves. Each ticket carries its `tracker` and `homes`: the repos
// whose own tracker listed it. A repo's tracker that fails leaves its tickets
// out; the global one failing throws. `repos` may be a promise (of
// localRepos()): the global tracker is asked without waiting for it.
/** @param {Repo[] | Promise<Repo[]>} repos @returns {Promise<Ticket[]>} */
export async function listTickets(repos) {
  const global = tracker();
  const globalList = global.list();
  globalList.catch(() => {}); // awaited below, unless the repo scan fails first
  /** @type {Map<import("./types.js").Tracker, Repo[]>} */
  const sources = new Map([[global, []]]);
  for (const r of await repos)
    if (r.tracker && r.tracker !== global)
      sources.set(r.tracker, [...(sources.get(r.tracker) ?? []), r]);
  const own = [...sources].slice(1);
  const [first, ...rest] = await Promise.all([
    globalList,
    ...own.map(([t]) => t.list().catch(() => [])),
  ]);
  /** @type {Map<string, Ticket & { homes: Repo[] }>} */
  const out = new Map();
  /** @type {[import("./types.js").Tracker, Repo[], Ticket[]][]} */
  const lists = [[global, [], first]];
  for (const [i, [t, homes]] of own.entries()) lists.push([t, homes, rest[i]]);
  for (const [t, homes, tickets] of lists)
    for (const ticket of tickets) {
      const seen = out.get(ticket.key);
      if (seen) seen.homes.push(...homes);
      else out.set(ticket.key, { ...ticket, tracker: t, homes: [...homes] });
    }
  return [...out.values()];
}

// A target ("owner/repo" or a path) -> local repo, or { slug } when not cloned.
/** @param {string | null | undefined} target @param {Repo[]} repos @returns {Repo | null} */
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
      name: basename(target),
      slug: target,
    }
  );
}

// Where a PR lookup's result lives in joinWork's `details`: by branch or number.
const prRef = (slug, ref) => `${slug}#${ref}`;

// The merge rules behind workFor, on plain data: key -> [{ repo, branch,
// worktree, pr }]. `states` are repoState results with their `repo`; a branch
// listed both as a worktree and a branch is one item. `linked` maps a key to
// the PRs ({ slug, number }) its tracker links; `details` maps prRef(slug,
// branch or number) to prDetails (missing = failed lookup, the item keeps pr
// null). A linked PR not already attached becomes its own item.
/**
 * @param {string[]} keys
 * @param {({ repo: Repo } & import("./git.js").RepoState | null)[]} states
 * @param {Map<string, PRRef[]>} [linked]
 * @param {Map<string, PR>} [details]
 * @param {Repo[]} [repos]
 * @returns {Map<string, WorkItem[]>}
 */
export function joinWork(
  keys,
  states,
  linked = new Map(),
  details = new Map(),
  repos = [],
) {
  /** @type {Map<string, WorkItem[]>} */
  const work = new Map(keys.map((k) => [k, []]));
  /** @param {string} key @param {WorkItem} item */
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
  for (const s of states) {
    if (!s) continue;
    /** @param {string | null} branch */
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
  for (const [key, items] of work) {
    for (const item of items)
      if (item.repo.slug)
        item.pr = details.get(prRef(item.repo.slug, item.branch)) ?? item.pr;
    for (const p of linked.get(key) ?? []) {
      const pr = details.get(prRef(p.slug, p.number));
      if (
        pr &&
        !items.some(
          (w) => sameSlug(w.repo.slug, pr.slug) && w.pr?.number === pr.number,
        )
      )
        add(key, {
          repo: /** @type {Repo} */ (findRepo(pr.slug, repos)),
          branch: pr.branch,
          worktree: null,
          pr,
        });
    }
  }
  return work;
}

// Every piece of work for each ticket (from listTickets), by key: [{ repo,
// branch, worktree, pr }], from local branches/worktrees whose name has the
// key and PRs the ticket's tracker links to it. Fetches joinWork's inputs.
// onLocal, if given, gets the local-only work first, before any PR lookup.
/** @param {Ticket[]} tickets @param {Repo[]} repos @param {{ prs?: boolean, onLocal?: (work: Map<string, WorkItem[]>) => void }} [opts] @returns {Promise<Map<string, WorkItem[]>>} */
export async function workFor(tickets, repos, { prs = true, onLocal } = {}) {
  const keys = tickets.map((t) => t.key);
  const states = await pool(
    repos
      .filter(
        /** @returns {r is Repo & { path: string }} */ (r) => r.path !== null,
      )
      .map((repo) => async () => ({ repo, ...(await repoState(repo)) })),
  );
  const local = joinWork(keys, states);
  if (!prs) return local;
  onLocal?.(joinWork(keys, states));

  // PRs: the branches we found, plus any PR the tracker links to the key.
  const byTracker = new Map();
  for (const t of tickets)
    byTracker.set(t.tracker, [...(byTracker.get(t.tracker) ?? []), t.key]);
  const linked = new Map();
  for (const found of await Promise.all(
    [...byTracker].map(([t, ks]) =>
      t.linkedPRs(ks, repos).catch(() => new Map()),
    ),
  ))
    for (const [k, v] of found) linked.set(k, v);
  const lookups = new Map();
  for (const [key, items] of local) {
    for (const item of items)
      if (item.repo.slug)
        lookups.set(prRef(item.repo.slug, item.branch), [
          item.repo.slug,
          item.branch,
        ]);
    for (const p of linked.get(key) ?? [])
      lookups.set(prRef(p.slug, p.number), [p.slug, p.number]);
  }
  // A failed lookup just leaves that item without PR details.
  const found = await pool(
    [...lookups.values()].map(
      ([slug, ref]) =>
        () =>
          prDetails(slug, ref),
    ),
  );
  const details = new Map();
  for (const [i, k] of [...lookups.keys()].entries())
    if (found[i]) details.set(k, found[i]);
  return joinWork(keys, states, linked, details, repos);
}

// Where new work on a ticket should go: [{ repo, why }] best first (may be
// empty): the repo last used for it, the repos whose own tracker listed it
// (ticket.homes), repoRules matching its component or label,
// what the tracker suggests (GitHub: the issue's repo), repoRules matching its
// project (only when no component/label rule matched), the current repo.
/** @param {Ticket} ticket @param {Repo[]} repos @param {string | null | undefined} here @param {string | null | undefined} remembered @returns {{ repo: Repo, why: string }[]} */
export function suggestRepos(ticket, repos, here, remembered) {
  /** @type {{ repo: Repo, why: string }[]} */
  const out = [];
  /** @param {Repo | null} repo @param {string} why */
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
