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

// The tracker for settings `s` (the global ones by default). The same
// settings give the same tracker, so trackers can be compared to group work.
/** @param {import("./config.js").Settings} [s] @returns {Tracker} */
export function tracker(s = C) {
  const t = trackers[s.tracker];
  if (!t)
    throw new Error(`unknown tracker "${s.tracker}" (use "jira" or "github")`);
  const id = JSON.stringify(s, (k, v) => (k === "problem" ? undefined : v));
  if (!made.has(id)) made.set(id, t.create(s));
  return /** @type {Tracker} */ (made.get(id));
}

// The tracker for a repo's tickets and branches (localRepos sets repo.tracker
// from the repo's own settings), the global one for any other repo.
/** @param {import("./types.js").Repo | null | undefined} repo @returns {Tracker} */
export const trackerOf = (repo) => repo?.tracker ?? tracker();
