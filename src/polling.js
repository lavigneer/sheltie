// What the polling sidebars (Work, Reviews) share (#251): how often they poll,
// the local repos found at most every REPOS_MS, and how a failed action is
// recorded and told.

import { notify as herdrNotify } from "herdr";
import { recordFailure } from "./diagnostics.js";
import { errorText } from "./errors.js";
import { localRepos } from "./git.js";

export const PR_MS = 120_000; // between PR lookups (and Reviews refreshes)
export const RETRY_MS = 60_000; // before a failed lookup is retried
// Between finds of the local repos (and reads of their settings); the polls in
// between reuse the last list.
export const REPOS_MS = 300_000;

// The last localRepos(), found again when forced, when stale, or never found.
export class RepoCache {
  constructor({ find = localRepos, maxAge = REPOS_MS, now = Date.now } = {}) {
    this.find = find;
    this.maxAge = maxAge;
    this.now = now;
    this.last = null; // { list, at }
  }

  get list() {
    return this.last?.list ?? [];
  }

  /** @param {boolean} [force] */
  async get(force = false) {
    if (force || !this.last || this.now() - this.last.at >= this.maxAge)
      this.last = { list: await this.find(), at: this.now() };
    return this.last.list;
  }
}

// A failed action: recorded for diagnostics and told as an error.
export function reportFailure(
  { mod, what, title, error, context = {} },
  { record = recordFailure, notify = herdrNotify } = {},
) {
  record(mod, what, error, context);
  notify({ title, body: errorText(error), level: "error" });
}
