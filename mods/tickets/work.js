// How tickets connect to repos, branches, worktrees and PRs, shared by the
// tickets popup and the Work sidebar. Ticket details come from the tracker in
// use (tracker.js).

import { C, REPO_FILE } from "./config.js";
import { basename, pool } from "./lib.js";
import { tracker, trackerOf } from "./tracker.js";
import { localRepos, repoState, sameSlug } from "./git.js";
import { prDetails } from "./prs.js";

// Your tickets from every tracker in use: the global one, then each one repos
// pick for themselves. Each ticket carries its `tracker` and `homes`: the repos
// whose own tracker listed it. A repo's tracker that fails leaves its tickets
// out; the global one failing throws. `repos` may be a promise (of
// localRepos()): the global tracker is asked without waiting for it.
export async function listTickets(repos) {
  const global = tracker();
  const globalList = global.list();
  globalList.catch(() => {}); // awaited below, unless the repo scan fails first
  const sources = new Map([[global, []]]);
  for (const r of await repos)
    if (r.tracker && r.tracker !== global)
      sources.set(r.tracker, [...(sources.get(r.tracker) ?? []), r]);
  const own = [...sources].slice(1);
  const [first, ...rest] = await Promise.all([
    globalList,
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
