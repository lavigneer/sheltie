// How tickets connect to repos, branches, worktrees and PRs, shared by the
// tickets popup and the Work sidebar. Ticket details come from the tracker in
// use (tracker.js).

import { C, REPO_FILE } from "./config.js";
import { repoState, sameSlug, touchedRepos } from "./git.js";
import { basename, pool } from "./lib.js";
import { PR_MS, RETRY_MS } from "./polling.js";
import { prDetailsMany, probePRs } from "./prs.js";
import { handleOf, ticketOfBranch, tracker, trackerOf } from "./tracker.js";
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

// The keys a PR's text names, for a branch whose name names none (work made
// outside the flow): those in its title, else those in its body.
/** @param {import("./types.js").Tracker} t @param {{ title?: string, body?: string } | null | undefined} pr @param {string | null} slug @returns {string[]} */
function keysInPR(t, pr, slug) {
  if (!pr) return [];
  const inTitle = t.keysIn(pr.title ?? "", slug);
  return inTitle.length ? inTitle : t.keysIn(pr.body ?? "", slug);
}

// A ticket the branch in `repo` names, else one its PR `pr` names.
/** @param {string | null} branch @param {Repo} repo @param {{ title?: string, body?: string } | null | undefined} pr @param {import("./types.js").Tracker} [t] @returns {import("./types.js").TicketHandle | null} */
function ticketOfWork(branch, repo, pr, t = trackerOf(repo)) {
  const own = ticketOfBranch(branch, repo, t);
  if (own) return own;
  const key = keysInPR(t, pr, repo.slug ?? null)[0];
  return key ? handleOf(t, key) : null;
}

// Where a PR lookup's result lives in joinWork's `details`: by branch or number.
/** @param {string} slug @param {string | number | null} ref */
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
// branch or number) to prDetailsMany (missing = failed lookup, the item keeps pr
// null). A linked PR not already attached becomes its own item.
/**
 * @param {string[] | null} keys (null: every key the work mentions)
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
  const work = new Map((keys ?? []).map((k) => [k, []]));
  // Each key's items with a branch, by repo and branch, so add finds a
  // duplicate without walking the list.
  /** @type {Map<string, Map<string, WorkItem>>} */
  const byBranch = new Map();
  /** @param {WorkItem} w */
  const branchId = (w) => `${w.repo.slug}|${w.repo.path}|${w.branch}`;
  /** @param {string} key @param {WorkItem} item */
  const add = (key, item) => {
    let list = work.get(key);
    if (!list) {
      if (keys) return;
      list = [];
      work.set(key, list);
    }
    let seen = byBranch.get(key);
    if (!seen) {
      seen = new Map();
      byBranch.set(key, seen);
    }
    const same = item.branch ? seen.get(branchId(item)) : undefined;
    if (same)
      Object.assign(
        same,
        Object.fromEntries(Object.entries(item).filter(([, v]) => v != null)),
      );
    else {
      list.push(item);
      if (item.branch) seen.set(branchId(item), item);
    }
  };
  for (const s of states) {
    if (!s) continue;
    const t = trackerOf(s.repo);
    // A worktree's branch is also a local branch: ask the tracker once.
    /** @type {Map<string | null, string[]>} */
    const asked = new Map();
    /** @param {string | null} branch */
    const mentioned = (branch) => {
      let ks = asked.get(branch);
      if (!ks) {
        ks = t.keysIn(branch, s.repo.slug);
        // A branch made outside the flow may name no key: its PR may.
        if (!ks.length && branch && s.repo.slug)
          ks = keysInPR(
            t,
            details.get(prRef(s.repo.slug, branch)),
            s.repo.slug,
          );
        asked.set(branch, ks);
      }
      return ks;
    };
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
  if (!keys) for (const k of linked.keys()) if (!work.has(k)) work.set(k, []);
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
// PRs their tracker links every 10 min; a failed lookup after a minute
// (PR_MS and RETRY_MS: polling.js).
export { PR_MS, RETRY_MS };
export const ACTIVE_PR_MS = 20_000;
export const TICKET_MS = 600_000;
// How often every repo's git state is read, whatever the find says (WorkStore.scan).
export const SWEEP_MS = 300_000;
// How long a quiet PR (see WorkStore.unchanged) is trusted on its probe alone
// after its last full lookup. Some changes don't move a PR's updatedAt (a
// conflict after its base moves, a review thread resolved), so this is the
// longest they can go unseen.
export const PR_FULL_MS = 600_000;
// A repo's first sweep falls this far into the SWEEP_MS window, derived from its
// path, so the sweeps of many repos spread out instead of landing on one tick.
// (FNV-1a, then a murmur-style mix: similar paths, like repo1 and repo2, must
// not land next to each other.)
export const sweepOffset = (/** @type {string} */ path) => {
  let h = 0x811c9dc5;
  for (const c of path) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) % SWEEP_MS;
};

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
// `repoState(repo)` and `prDetailsMany(slug, items, { requiredOnly })`; trackers (view,
// linkedPRs) come with the keys asked about.
// What a scan found, as text to compare with the last scan's. A repo whose
// state couldn't be read is null (scan): it's part of the key, so its rows
// going away counts as a change.
/** @param {any[]} states */
const statesKey = (states) =>
  JSON.stringify(
    states.map(
      (s) =>
        s && [
          s.repo.path,
          s.mainBranch,
          s.linked,
          s.worktrees,
          [...(s.branches ?? [])],
        ],
    ),
  );

export class WorkStore {
  /** @type {string | undefined} */
  statesKey;

  constructor({
    sources = {
      repoState,
      prDetailsMany,
      prProbeMany: probePRs,
      touched: touchedRepos,
    },
    now = Date.now,
    retryMs = RETRY_MS,
  } = {}) {
    this.sources = sources;
    this.now = now;
    // When each repo's next sweep read is due, by path (see scan). Each repo
    // has its own phase, so the sweeps don't all land on one refresh tick.
    /** @type {Map<string, number>} */
    this.sweepAt = new Map();
    /** @type {Repo[]} */
    this.repos = [];
    /** @type {({ repo: Repo } & import("./git.js").RepoState | null)[]} */
    this.states = [];
    this.tickets = new Cache({ retryMs, now });
    this.linked = new Cache({ retryMs, now });
    this.prs = new Cache({ retryMs, now });
    // When each PR was last looked up in full (ref -> time), for PR_FULL_MS.
    /** @type {Map<string, number>} */
    this.fullAt = new Map();
    // Bumped by scan; with the caches' versions, says when snapshots go stale.
    this.version = 0;
    /** @type {{ at: string, all: Map<string, WorkItem[]> }} */
    this.snapshots = { at: "", all: new Map() };
    // How many times the join ran (a render can tell whether it rebuilt).
    this.rebuilds = 0;
  }

  // Git: the worktrees and branches of `repos` (those with a path). A repo
  // whose .git was not touched since the last scan keeps its state (one find
  // for all of them, see touchedRepos). Each repo is also read once every
  // SWEEP_MS for what the find can't see (a worktree folder removed by hand).
  // Those sweeps are phased per repo (sweepOffset), so they spread over the
  // window instead of all landing on one refresh. With no touched source, or
  // when the find fails (null), every repo is read.
  /** @param {Repo[]} repos */
  async scan(repos) {
    const local = repos.filter(
      /** @returns {r is Repo & { path: string }} */ (r) => r.path !== null,
    );
    const known = new Map(
      this.states.flatMap((s) => (s ? [[s.repo.path, s]] : [])),
    );
    const now = this.now();
    const touched = this.sources.touched
      ? await this.sources.touched(local.map((r) => r.path))
      : null;
    const states = await pool(
      local.map((repo) => async () => {
        const old = known.get(repo.path);
        const sweepDue = now >= (this.sweepAt.get(repo.path) ?? Infinity);
        if (touched && old && !touched.has(repo.path) && !sweepDue)
          return { ...old, repo };
        // The next sweep is a whole SWEEP_MS later, except a repo's first read,
        // which takes its phase: spread the first sweeps across the window.
        this.sweepAt.set(
          repo.path,
          now + (old ? SWEEP_MS : sweepOffset(repo.path)),
        );
        return { repo, ...(await this.sources.repoState(repo)) };
      }),
    );
    const paths = new Set(local.map((r) => r.path));
    for (const path of this.sweepAt.keys())
      if (!paths.has(path)) this.sweepAt.delete(path);
    // A scan that finds what the last one did changes nothing: the version
    // (and so the join, and the view) stays.
    const key = statesKey(states);
    if (repos !== this.repos || key !== this.statesKey) this.version++;
    this.repos = repos;
    this.states = states;
    this.statesKey = /** @type {string} */ (key);
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
    // Rendering asks once per row, each for its own key; the join walks every
    // branch of every repo, so join everything once and reuse it until a scan
    // or lookup changes what is known.
    const at = `${this.version}.${this.linked.version}.${this.prs.version}`;
    if (this.snapshots.at !== at) {
      this.snapshots = { at, all: this.join() };
      this.rebuilds++;
    }
    const { all } = this.snapshots;
    return new Map(keys.map((k) => [k, all.get(k) ?? []]));
  }

  // Rebuilds the snapshot now if a scan or lookup made it stale, so the next
  // render only reads it: the join is the expensive part, and off the render
  // path it can't get the render interrupted.
  warm() {
    this.snapshot([]);
  }

  // The work on every key the repos and linked PRs mention.
  /** @returns {Map<string, WorkItem[]>} */
  join() {
    const details = new Map();
    for (const [ref, e] of this.prs.entries)
      if (e.value) details.set(ref, e.value);
    const linked = new Map();
    for (const [k, e] of this.linked.entries)
      if (e.value) linked.set(k, e.value);
    return joinWork(null, this.states, linked, details, this.repos);
  }

  // The PR lookup entry for `branch` in `repo` (state "found" | "none" |
  // "failed"), or undefined when not looked up yet.
  /** @param {Repo} repo @param {string | null} branch */
  prEntry(repo, branch) {
    return repo.slug ? this.prs.get(prRef(repo.slug, branch)) : undefined;
  }

  // A worktree `w` ({ path, repo, branch }) resolved against what is known:
  // `handle`, the ticket its branch names, else the one its PR names; `pr`,
  // its branch's PR, else one its ticket's tracker links with that branch;
  // `items`, all its ticket's work (empty without a ticket); `pr` and
  // `items` are worked out when read. A row that
  // carries a `handle` (resolved by a scan, or adopt) keeps it, so a render
  // doesn't ask the tracker again. `t`: the repo's tracker, when the caller
  // already has it (a scan asks once per repo).
  /**
   * @param {{ path: string, repo: Repo, branch: string | null, handle?: import("./types.js").TicketHandle | null }} w
   * @param {import("./types.js").Tracker} [t]
   * @returns {{ handle: import("./types.js").TicketHandle | null, pr: PR | null, items: WorkItem[] }}
   */
  rowFor(w, t) {
    const own = this.prEntry(w.repo, w.branch)?.value ?? null;
    const handle =
      w.handle !== undefined
        ? w.handle
        : ticketOfWork(w.branch, w.repo, own, t);
    // `pr` and `items` read the join (snapshot) only when asked: a scan
    // wants just the handle.
    const store = this;
    return {
      handle,
      get items() {
        return handle
          ? (store.snapshot([handle.key]).get(handle.key) ?? [])
          : [];
      },
      get pr() {
        return own ?? this.items.find((i) => i.worktree === w.path)?.pr ?? null;
      },
    };
  }

  // Gives `rows` (worktrees with a `handle`) whose branch names no ticket the
  // one PR `pr`, just looked up as `ref`, names: a branch made outside the
  // flow still shows and moves its ticket. True when one changed.
  /** @param {{ path: string, repo: Repo, branch: string | null, handle: any }[]} rows @param {string} ref @param {PR | null | undefined} pr */
  adopt(rows, ref, pr) {
    if (!pr) return false;
    let changed = false;
    for (const w of rows)
      if (!w.handle && w.repo.slug && prRef(w.repo.slug, w.branch) === ref) {
        w.handle = ticketOfWork(w.branch, w.repo, pr);
        changed ||= Boolean(w.handle);
      }
    return changed;
  }

  // Whether the PR lookup `ref` (which found `pr`) is worktree `w`'s PR: by
  // its branch, or as the PR its row resolves to.
  /** @param {{ path: string, repo: Repo, branch: string | null }} w @param {string} ref @param {PR | null | undefined} pr */
  ownsPR(w, ref, pr) {
    if (w.repo.slug && prRef(w.repo.slug, w.branch) === ref) return true;
    const mine = pr && this.rowFor(w).pr;
    return Boolean(
      mine && mine.number === pr.number && sameSlug(mine.slug, pr.slug),
    );
  }

  // The due PRs of `slug` (`items`, as refresh has them) that a probe says are
  // as they were at their last full lookup: ref -> their details, to keep. Only
  // quiet PRs qualify (not the active ones of prMaxAge, which are polled as
  // before), and only within PR_FULL_MS of their last full lookup, since some
  // changes (checks finishing, a conflict after the base moves) may not move
  // updatedAt. A failed probe leaves every PR to a full lookup.
  /** @param {string} slug @param {{ ref: string, r: string | number, was: any }[]} items @returns {Promise<Map<string, any>>} */
  async unchanged(slug, items) {
    const out = new Map();
    if (!this.sources.prProbeMany) return out;
    const now = this.now();
    const quiet = items.filter(
      ({ ref, was }) =>
        this.prs.get(ref)?.state !== "failed" &&
        prMaxAge(was) !== ACTIVE_PR_MS &&
        now - (this.fullAt.get(ref) ?? -Infinity) < PR_FULL_MS,
    );
    if (!quiet.length) return out;
    /** @type {Map<string | number, any>} */
    let probed;
    try {
      probed = await this.sources.prProbeMany(
        slug,
        quiet.map(({ r }) => r),
      );
    } catch {
      return out;
    }
    for (const { ref, r, was } of quiet) {
      const p = probed.get(r);
      if (p instanceof Error || p === undefined) continue;
      // Same PR, same updatedAt. None before and none now is the same too.
      const same = was
        ? p !== null &&
          p.updatedAt != null &&
          p.number === was.number &&
          p.updatedAt === was.updatedAt
        : p === null;
      if (same) out.set(ref, was);
    }
    return out;
  }

  // Looks up what is due (everything, when forced) for `keys` (key ->
  // its tracker): with `view`, each ticket; the PRs its tracker links, then
  // every PR of their work. onLinked gets the linked PRs before the PR
  // lookups; onPR(ref, was, entry, asked) follows each PR lookup.
  /**
   * @param {Map<string, import("./types.js").Tracker>} keys
   * @param {{ force?: boolean, view?: boolean, branches?: { repo: Repo, branch: string | null }[], onTicket?: (key: string) => void, onLinked?: (linked: Map<string, PRRef[]>) => void, onPR?: (ref: string, was: PR | null, entry: any, asked: number) => void }} [opts]
   */
  async refresh(
    keys,
    {
      force = false,
      view = false,
      branches = [],
      onTicket,
      onLinked,
      onPR,
    } = {},
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
          // Each tracker's links land while others are still awaited, and a
          // render (Herdr's, when a space appears) may run then: rebuild the
          // join here so it never runs in that render (#282).
          this.warm();
        }),
      );
      onLinked?.(this.linkedFor(ks));
      /** @type {Map<string, [string, string | number]>} */
      const lookups = new Map();
      // Branches that name no ticket (made outside the flow): their PR may.
      for (const { repo, branch } of branches)
        if (repo.slug && branch)
          lookups.set(prRef(repo.slug, branch), [repo.slug, branch]);
      for (const [key, items] of this.snapshot(ks)) {
        const linked = this.linked.get(key)?.value ?? [];
        // Each linked PR is looked up one way: by its item's branch once that
        // has been looked up (a local branch's PR), else by number. A PR
        // found only by number gets a branch in the join; asking that too
        // would poll it twice (#367).
        /** @param {PRRef} p @param {WorkItem} w */
        const byBranch = (p, w) =>
          sameSlug(w.repo.slug, p.slug) &&
          w.pr?.number === p.number &&
          this.prs.get(prRef(/** @type {string} */ (w.repo.slug), w.branch)) !==
            undefined;
        for (const item of items)
          if (
            item.repo.slug &&
            item.branch &&
            !linked.some(
              (/** @type {PRRef} */ p) =>
                sameSlug(item.repo.slug, p.slug) &&
                item.pr?.number === p.number &&
                !byBranch(p, item),
            )
          )
            lookups.set(prRef(item.repo.slug, item.branch), [
              item.repo.slug,
              item.branch,
            ]);
        for (const p of linked)
          if (!items.some((w) => byBranch(p, w)))
            lookups.set(prRef(p.slug, p.number), [p.slug, p.number]);
      }
      // The due ones, by repo: one batched lookup per repo (prDetailsMany).
      /** @type {Map<string, { ref: string, r: string | number, was: any }[]>} */
      const due = new Map();
      for (const [ref, [slug, r]] of lookups)
        if (this.prs.due(ref, prMaxAge(this.prs.get(ref)?.value), { force }))
          due.set(slug, [
            ...(due.get(slug) ?? []),
            { ref, r, was: this.prs.get(ref)?.value ?? null },
          ]);
      await pool(
        [...due].map(([slug, items]) => async () => {
          const asked = this.now();
          const quiet = force ? new Map() : await this.unchanged(slug, items);
          const todo = items.filter(({ ref }) => !quiet.has(ref));
          const found = todo.length
            ? await this.sources.prDetailsMany(
                slug,
                todo.map(({ r, was }) => ({ ref: r, previous: was })),
                { requiredOnly: C.requiredChecksOnly },
              )
            : new Map();
          for (const { ref, r, was } of items) {
            const isQuiet = quiet.has(ref);
            const entry = await this.prs.refresh(ref, async () => {
              const pr = isQuiet ? was : found.get(r);
              if (pr instanceof Error) throw pr;
              return pr;
            });
            if (!isQuiet && entry.state !== "failed")
              this.fullAt.set(ref, asked);
            onPR?.(ref, was, entry, asked);
          }
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
  /** @param {any[]} list @param {unknown} v */
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
