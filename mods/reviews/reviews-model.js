// The Reviews sidebar's model (#251): the queue, the review worktrees and what
// a row does, with no View, timers or cx, so tests reach the real path.
// reviews/main.js draws it and schedules refresh().

import { notify as herdrNotify } from "herdr";
import { C, configReady } from "./config.js";
import { sameSlug } from "./git.js";
import { RETRY_MS, RepoCache, reportFailure } from "./polling.js";
import { reviewQueue, reviewRequests } from "./prs.js";
import {
  allReviewWorktrees,
  finishReview,
  openSpaces,
  prepareReview,
  sweepReviews,
} from "./start.js";
import { Cache } from "./watch.js";

/** @param {{ number: number, slug: string | null }} a @param {{ number: number, slug: string | null }} b */
const samePR = (a, b) => a.number === b.number && sameSlug(a.slug, b.slug);

export const DEFAULT_SOURCES = {
  ready: configReady,
  requests: () => reviewRequests(C.reviewSearch),
  worktrees: allReviewWorktrees,
  sweep: sweepReviews,
  finish: finishReview,
  prepare: prepareReview,
  open: openSpaces,
  notify: herdrNotify,
  record: undefined, // reportFailure's default (recordFailure)
};

export class ReviewsModel {
  constructor({
    repos = new RepoCache(),
    sources = {},
    retryMs = RETRY_MS,
    now = Date.now,
  } = {}) {
    this.src = { ...DEFAULT_SOURCES, ...sources };
    this.repoCache = repos;
    // One entry, "queue": the last good queue survives a failed refresh.
    this.cache = new Cache({ retryMs, now });
    /** @type {any[]} */
    this.worktrees = []; // review worktrees still here, after sweeping
    /** @type {any[]} */
    this.reviewed = []; // of those, the ones whose PR left the queue
    this.warned = new Set(); // paths whose automatic teardown was refused
    this.starting = false; // one start at a time: no double checkout
  }

  /** @returns {any[]} */
  get repos() {
    return this.repoCache.list;
  }

  get entry() {
    return this.cache.get("queue");
  }

  /** @returns {any[]} */
  get queue() {
    return this.entry?.value ?? [];
  }

  // The queue length once loaded, else null (switcher.js REVIEW_COUNT).
  get count() {
    return this.entry?.value ? this.entry.value.length : null;
  }

  get failed() {
    return this.entry?.state === "failed";
  }

  // Asks for the queue again (repos found again when forced or stale), then
  // sweeps. A failed sweep keeps the last worktrees.
  async refresh(force = false) {
    await this.src.ready();
    await this.cache.refresh("queue", async () => {
      const [repos, data] = await Promise.all([
        this.repoCache.get(force),
        this.src.requests(),
      ]);
      return reviewQueue(
        data,
        repos.flatMap((r) => (r.slug ? [r.slug] : [])),
      );
    });
    await this.sweep().catch(() => {});
  }

  // Tears down review worktrees whose PR merged or closed; a refusal is told
  // once per worktree.
  async sweep() {
    const queue = this.queue;
    const all = await this.src.worktrees(this.repos);
    const { kept, refused } = await this.src.sweep(all, queue);
    for (const w of refused)
      if (!this.warned.has(w.path)) {
        this.warned.add(w.path);
        this.src.notify({
          title: `${w.slug}#${w.number}: review worktree kept`,
          body: w.why,
          level: "warning",
        });
      }
    // sweepReviews leaves queued ones alone: those stay, with kept.
    const keptPaths = new Set(kept.map((w) => w.path));
    /** @param {any} w */
    const queued = (w) => queue.some((r) => samePR(r, w));
    this.worktrees = all.filter((w) => queued(w) || keptPaths.has(w.path));
    this.reviewed = kept.filter((w) => !queued(w));
  }

  /** @param {any} r */
  worktreeOf(r) {
    return this.worktrees.find((w) => samePR(w, r));
  }

  // Starts reviewing r: its PR checked out in a review worktree, in a space.
  // false when one is already starting.
  /** @param {any} r */
  async start(r) {
    if (this.starting) return false;
    this.starting = true;
    try {
      const repo = this.repos.find((x) => x.path && sameSlug(x.slug, r.slug));
      if (!repo) throw new Error(`${r.slug} isn't checked out here`);
      this.src.open([await this.src.prepare(r, repo)]);
    } catch (e) {
      this.fail("start review", "couldn't start the review", r, e);
    } finally {
      this.starting = false;
    }
    return true;
  }

  // Done reviewing: tears w's worktree down; true when it went.
  /** @param {any} w */
  async done(w) {
    try {
      await this.src.finish(w.repo, w);
    } catch (e) {
      this.fail("tear down review", "couldn't tear down the review", w, e);
      return false;
    }
    this.worktrees = this.worktrees.filter((x) => x.path !== w.path);
    this.reviewed = this.reviewed.filter((x) => x.path !== w.path);
    return true;
  }

  /** @param {string} what @param {string} title @param {{ slug: string, number: number }} pr @param {unknown} error */
  fail(what, title, pr, error) {
    const name = `${pr.slug}#${pr.number}`;
    reportFailure(
      {
        mod: "reviews",
        what,
        title: `${name}: ${title}`,
        error,
        context: { pr: name },
      },
      this.src.record
        ? { notify: this.src.notify, record: this.src.record }
        : { notify: this.src.notify },
    );
  }
}
