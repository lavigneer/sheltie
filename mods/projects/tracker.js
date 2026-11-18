// Ticket trackers: the global one (C.tracker) and any a repo's own settings
// pick (config.js repoSettings). Each tracker module's create(settings) gives:
//   name
//   list()                 your tickets: [{ key, label, ref, summary, status,
//                          components, labels, project, repo }]
//   view(key)              one ticket; null if there's no such ticket, throws
//                          when the tracker can't be reached
//   move(key, step, status)  for workflow step "start" | "review" | "done";
//                          returns a note, or null when there's nothing to do
//   url(key)               where to see it in the browser (a promise; null
//                          when it can't tell)
//   viewCommand(key)       a shell command that prints it (for the agent)
//   labelOf(key)           short form for display
//   keysIn(text, slug)     keys a branch name or PR text (in repo slug) mentions
//   linkedPRs(keys, repos) PRs linked to each key: Map key -> [{ slug, number }]
//   suggest(ticket)        repos the tracker itself suggests: [{ target, why }]

import { C } from "./config.js";
import * as github from "./tracker-github.js";
import * as jira from "./tracker-jira.js";

/** @typedef {import("./types.js").Tracker} Tracker */

/** @type {Record<string, { create: (s: import("./config.js").Settings) => Tracker }>} */
const trackers = { jira, github };
/** @type {Map<string, Tracker>} */
const made = new Map();
// The same lookup by settings object, so callers asking with the same object
// (every trackerOf without a repo tracker) skip building the JSON key.
/** @type {WeakMap<object, Tracker>} */
const bySettings = new WeakMap();

// The tracker for settings `s` (the global ones by default). The same
// settings give the same tracker, so trackers can be compared to group work.
/** @param {import("./config.js").Settings} [s] @returns {Tracker} */
export function tracker(s = C) {
  const known = bySettings.get(s);
  if (known) return known;
  const t = trackers[s.tracker];
  if (!t)
    throw new Error(`unknown tracker "${s.tracker}" (use "jira" or "github")`);
  const id = JSON.stringify(s, (k, v) => (k === "problem" ? undefined : v));
  if (!made.has(id)) made.set(id, t.create(s));
  const found = /** @type {Tracker} */ (made.get(id));
  bySettings.set(s, found);
  return found;
}

// The tracker for a repo's tickets and branches (localRepos sets repo.tracker
// from the repo's own settings), the global one for any other repo.
/** @param {import("./types.js").Repo | null | undefined} repo @returns {Tracker} */
export const trackerOf = (repo) => repo?.tracker ?? tracker();

// A ticket a branch in `repo` names, resolved once: its key and display label
// with the tracker's url/move bound to it. Null when the branch names none.
/** @param {string | null} branch @param {import("./types.js").Repo | null | undefined} repo @returns {import("./types.js").TicketHandle | null} */
export function ticketOfBranch(branch, repo) {
  const t = trackerOf(repo);
  const key = t.keysIn(branch, repo?.slug ?? null)[0];
  return key ? handleOf(t, key) : null;
}

// The keys a PR's text names, for a branch whose name names none (work made
// outside the flow): those in its title, else those in its body.
/** @param {Tracker} t @param {{ title?: string, body?: string } | null | undefined} pr @param {string | null} slug @returns {string[]} */
export function keysInPR(t, pr, slug) {
  if (!pr) return [];
  const inTitle = t.keysIn(pr.title ?? "", slug);
  return inTitle.length ? inTitle : t.keysIn(pr.body ?? "", slug);
}

// A ticket the branch in `repo` names, else one its PR `pr` names.
/** @param {string | null} branch @param {import("./types.js").Repo | null | undefined} repo @param {{ title?: string, body?: string } | null} [pr] @returns {import("./types.js").TicketHandle | null} */
export function ticketOfWork(branch, repo, pr = null) {
  const own = ticketOfBranch(branch, repo);
  if (own) return own;
  const t = trackerOf(repo);
  const key = keysInPR(t, pr, repo?.slug ?? null)[0];
  return key ? handleOf(t, key) : null;
}

// The handle for ticket `key` in tracker `t`.
/** @param {Tracker} t @param {string} key @returns {import("./types.js").TicketHandle} */
export const handleOf = (t, key) => ({
  key,
  label: t.labelOf(key),
  tracker: t,
  url: () => t.url(key),
  move: (step, status) => t.move(key, step, status),
});
