// How tickets connect to repos, branches, worktrees and PRs, shared by the
// tickets popup and the Work sidebar. Ticket details come from the tracker in
// use (tracker.js).

import { C, REPO_FILE } from "./config.js";
import { repoState, sameSlug } from "./git.js";
import { basename, pool } from "./lib.js";
import { prDetails } from "./prs.js";
import { tracker, trackerOf } from "./tracker.js";
import { Cache } from "./watch.js";

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
  /** @type {[import("./types.js").Tracker, Repo[], import("./types.js").TrackerTicket[]][]} */
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

// Ticket `key` looked up in the tracker for `repo` (its own, else the global
// one), carrying that tracker and, when it's the repo's own, the repo as its
// home. Null when there's no such ticket or the tracker can't be reached.
/** @param {string} key @param {Repo | null | undefined} repo @returns {Promise<Ticket | null>} */
export async function viewTicket(key, repo) {
  const t = trackerOf(repo);
  const viewed = await t.view(key).catch(() => null);
  const homes = repo?.tracker && repo.tracker === t ? [repo] : [];
  return viewed && { ...viewed, tracker: t, homes };
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
export const prRef = (slug, ref) => `${slug}#${ref}`;

// Whether a work item is open work (GLOSSARY.md): its branch or PR hasn't
// merged or closed. An item with no PR known (none yet, or a failed lookup)
// counts as open.
/** @param {WorkItem} item */
const isOpenWork = (item) =>
  item.pr?.state !== "MERGED" && item.pr?.state !== "CLOSED";

// The open work a ticket has (`work`: its WorkItem[]) besides worktree `self`
// ({ path, repo, branch }, with PR `pr`), wherever it is: other repos, other
// machines, fork PRs. Without `self`, all its open work. The ticket is
// resolved when this is empty.
/**
 * @param {WorkItem[]} work
 * @param {{ path: string, repo: Repo, branch: string | null } | null} [self]
 * @param {{ number: number, slug: string } | null} [pr]
 * @returns {WorkItem[]}
 */
export const openWork = (work, self = null, pr = null) =>
  work.filter((i) => isOpenWork(i) && !(self && isItem(i, self, pr)));

// Whether work item `i` is worktree `w` (with PR `pr`) itself.
/** @param {WorkItem} i @param {{ path: string, repo: Repo, branch: string | null }} w @param {{ number: number, slug: string } | null} pr */
const isItem = (i, w, pr) =>
  i.worktree === w.path ||
  (i.repo.path === w.repo.path && i.branch === w.branch) ||
  (pr != null && i.pr?.number === pr.number && sameSlug(i.pr.slug, pr.slug));

// A work item as a note names it: its worktree, else its PR, else its branch.
/** @param {WorkItem} i */
export const workName = (i) =>
  i.worktree
    ? basename(i.worktree)
    : i.pr
      ? `${i.pr.slug}#${i.pr.number}`
      : i.branch;

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

// How often each source is asked again (WorkStore.refresh): PRs every 2 min,
// 20 s while CI runs, a merge is pending or it may conflict; tickets and the
// PRs their tracker links every 10 min; a failed lookup after a minute.
export const PR_MS = 120_000;
export const ACTIVE_PR_MS = 20_000;
export const TICKET_MS = 600_000;
export const RETRY_MS = 60_000;

// How long a PR's details stay fresh: shorter while something you'd wait for
// may change soon (conflicts, or not known yet: CI starts soon after a fix).
/** @param {PR | null | undefined} pr */
export const prMaxAge = (pr) =>
  pr?.state === "OPEN" &&
  (pr.checks === "pending" ||
    pr.autoMerge ||
    pr.review === "APPROVED" ||
    pr.mergeable !== "MERGEABLE")
    ? ACTIVE_PR_MS
    : PR_MS;

// The work on tickets, kept up to date: the one place that joins repo state,
// tracker-linked PRs and PR details (joinWork) and decides what is due for a
// lookup. Holds the caches (Cache, watch.js): tickets and linked PRs by key,
// PR details by prRef (slug#branch or slug#number). Sources are injected:
// `repoState(repo)` and `prDetails(slug, ref, previous)`; trackers (view,
// linkedPRs) come with the keys asked about.
export class WorkStore {
  constructor({
    sources = { repoState, prDetails },
    now = Date.now,
    retryMs = RETRY_MS,
  } = {}) {
    this.sources = sources;
    this.now = now;
    /** @type {Repo[]} */
    this.repos = [];
    /** @type {({ repo: Repo } & import("./git.js").RepoState | null)[]} */
    this.states = [];
    this.tickets = new Cache({ retryMs, now });
    this.linked = new Cache({ retryMs, now });
    this.prs = new Cache({ retryMs, now });
  }

  // Git: the worktrees and branches of `repos` (those with a path).
  /** @param {Repo[]} repos */
  async scan(repos) {
    const local = repos.filter(
      /** @returns {r is Repo & { path: string }} */ (r) => r.path !== null,
    );
    const states = await pool(
      local.map((repo) => async () => ({
        repo,
        ...(await this.sources.repoState(repo)),
      })),
    );
    this.repos = repos;
    this.states = states;
  }

  // The PRs trackers link to each key, as last looked up.
  /** @param {string[]} keys @returns {Map<string, PRRef[]>} */
  linkedFor(keys) {
    return new Map(
      keys.flatMap((k) => {
        const v = this.linked.get(k)?.value;
        return v ? [[k, v]] : [];
      }),
    );
  }

  // The work on each key, from what is known now.
  /** @param {string[]} keys @returns {Map<string, WorkItem[]>} */
  snapshot(keys) {
    const details = new Map();
    for (const [ref, e] of this.prs.entries)
      if (e.value) details.set(ref, e.value);
    return joinWork(
      keys,
      this.states,
      this.linkedFor(keys),
      details,
      this.repos,
    );
  }

  // The PR lookup entry for `branch` in `repo` (state "found" | "none" |
  // "failed"), or undefined when not looked up yet.
  /** @param {Repo} repo @param {string | null} branch */
  prEntry(repo, branch) {
    return repo.slug ? this.prs.get(prRef(repo.slug, branch)) : undefined;
  }

  // Looks up what is due (everything, when forced) for `keys` (key ->
  // its tracker): with `view`, each ticket; the PRs its tracker links, then
  // every PR of their work. onLinked gets the linked PRs before the PR
  // lookups; onPR(ref, was, entry, asked) follows each PR lookup.
  /**
   * @param {Map<string, import("./types.js").Tracker>} keys
   * @param {{ force?: boolean, view?: boolean, onTicket?: (key: string) => void, onLinked?: (linked: Map<string, PRRef[]>) => void, onPR?: (ref: string, was: PR | null, entry: any, asked: number) => void }} [opts]
   */
  async refresh(
    keys,
    { force = false, view = false, onTicket, onLinked, onPR } = {},
  ) {
    const ks = [...keys.keys()];
    const tickets = view
      ? pool(
          ks
            .filter((k) => this.tickets.due(k, TICKET_MS, { force }))
            .map((k) => async () => {
              await this.tickets.refresh(k, () =>
                /** @type {any} */ (keys.get(k)).view(k),
              );
              onTicket?.(k);
            }),
        )
      : Promise.resolve();
    const prs = (async () => {
      /** @type {Map<any, string[]>} */
      const byTracker = new Map();
      for (const k of ks)
        if (this.linked.due(k, TICKET_MS, { force }))
          byTracker.set(keys.get(k), [
            ...(byTracker.get(keys.get(k)) ?? []),
            k,
          ]);
      await Promise.all(
        [...byTracker].map(async ([t, group]) => {
          const found = t.linkedPRs(group, this.repos);
          found.catch(() => {});
          for (const k of group)
            await this.linked.refresh(
              k,
              async () => (await found).get(k) ?? [],
            );
        }),
      );
      onLinked?.(this.linkedFor(ks));
      /** @type {Map<string, [string, string | number]>} */
      const lookups = new Map();
      for (const [key, items] of this.snapshot(ks)) {
        for (const item of items)
          if (item.repo.slug && item.branch)
            lookups.set(prRef(item.repo.slug, item.branch), [
              item.repo.slug,
              item.branch,
            ]);
        // A linked PR already attached by branch is looked up that way.
        for (const p of this.linked.get(key)?.value ?? [])
          if (
            !items.some(
              (w) => sameSlug(w.repo.slug, p.slug) && w.pr?.number === p.number,
            )
          )
            lookups.set(prRef(p.slug, p.number), [p.slug, p.number]);
      }
      await pool(
        [...lookups]
          .filter(([ref]) =>
            this.prs.due(ref, prMaxAge(this.prs.get(ref)?.value), { force }),
          )
          .map(([ref, [slug, r]]) => async () => {
            const was = this.prs.get(ref)?.value ?? null;
            const asked = this.now();
            const entry = await this.prs.refresh(ref, () =>
              this.sources.prDetails(slug, r, was),
            );
            onPR?.(ref, was, entry, asked);
          }),
      );
    })();
    await Promise.all([tickets, prs]);
  }
}

// Every piece of work for each ticket (from listTickets), by key: [{ repo,
// branch, worktree, pr }], from local branches/worktrees whose name has the
// key and PRs the ticket's tracker links to it, all looked up now (WorkStore).
// onLocal, if given, gets the local-only work first, before any PR lookup;
// onLinked then gets the PRs each ticket's tracker links (key -> PRRef[]),
// before their details are looked up.
/** @param {Ticket[]} tickets @param {Repo[]} repos @param {{ prs?: boolean, onLocal?: (work: Map<string, WorkItem[]>) => void, onLinked?: (linked: Map<string, PRRef[]>) => void, store?: WorkStore }} [opts] @returns {Promise<Map<string, WorkItem[]>>} */
export async function workFor(
  tickets,
  repos,
  { prs = true, onLocal, onLinked, store = new WorkStore() } = {},
) {
  const keys = tickets.map((t) => t.key);
  await store.scan(repos);
  if (!prs) return store.snapshot(keys);
  onLocal?.(store.snapshot(keys));
  await store.refresh(new Map(tickets.map((t) => [t.key, t.tracker])), {
    force: true,
    onLinked,
  });
  return store.snapshot(keys);
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
  for (const s of ticket.tracker.suggest(ticket))
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
