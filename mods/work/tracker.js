// The ticket tracker in use (C.tracker). Each tracker module exports:
//   name
//   list()                 your tickets: [{ key, label, ref, summary, status,
//                          components, labels, project, repo }]
//   view(key)              one ticket; null if there's no such ticket, throws
//                          when the tracker can't be reached
//   move(key, step, status)  for workflow step "start" | "review" | "done";
//                          returns a note, or null when there's nothing to do
//   url(key)               where to see it in the browser
//   viewCommand(key)       a shell command that prints it (for the agent)
//   labelOf(key)           short form for display
//   keysIn(text, slug)     keys a branch name or PR text (in repo slug) mentions
//   linkedPRs(keys, repos) PRs linked to each key: Map key -> [{ slug, number }]
//   suggest(ticket)        repos the tracker itself suggests: [{ target, why }]

import { C } from "./config.js";
import * as github from "./tracker-github.js";
import * as jira from "./tracker-jira.js";

const trackers = { jira, github };

export function tracker() {
  const t = trackers[C.tracker];
  if (!t) throw new Error(`unknown tracker "${C.tracker}" (use "jira" or "github")`);
  return t;
}
