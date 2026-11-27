// How long the Work sidebar's refreshes take, and what they spawned (work.report's
// `refreshes`): a count, the mean, the 95th percentile and the slowest of the
// last WINDOW refreshes, and the mean spawns and rate-limited calls per refresh
// over that window. Totals for the whole session come from lib.js's callCounts,
// which the report also carries. Kept in memory only, as renders.js is: a record
// per refresh would fill the diagnostics folder (KEEP) in minutes.
//
// A Work refresh is one git scan (work/main.js scan); a Reviews refresh is one
// queue refresh (reviews/main.js). Calls to gh and jira made by the
// lookups that run alongside it are counted in the totals, not in a refresh.

// The Reviews sidebar's report() and quota() (lib.js; each mod has its own),
// published after each of its refreshes for work.report's `reviews`.
export const REVIEWS_STATS = "reviews.stats";

export const WINDOW = 200; // how many recent refreshes the percentiles use

/** @typedef {{ ms: number, spawns: Record<string, number>, rateLimited: number }} Refresh */

export class RefreshStats {
  constructor() {
    this.count = 0;
    /** @type {Refresh[]} */
    this.window = []; // the last WINDOW refreshes, oldest first
  }

  // Adds one refresh: its wall time, and the calls made while it ran (lib.js's callsSince).
  /** @param {Refresh} r */
  add(r) {
    this.count++;
    this.window.push(r);
    if (this.window.length > WINDOW) this.window.shift();
  }

  // For work.report.
  report() {
    const n = this.window.length;
    /** @type {Record<string, number>} */
    const spawns = {};
    for (const r of this.window)
      for (const [name, k] of Object.entries(r.spawns))
        spawns[name] = (spawns[name] ?? 0) + k;
    const sorted = this.window.map((r) => r.ms).sort((a, b) => a - b);
    return {
      count: this.count,
      window: n,
      meanMs: n ? sorted.reduce((a, b) => a + b, 0) / n : null,
      p95Ms: n ? sorted[Math.ceil(0.95 * n) - 1] : null,
      maxMs: n ? sorted[n - 1] : null,
      // Mean calls per refresh, by program (window only).
      spawnsPerRefresh: Object.fromEntries(
        Object.entries(spawns).map(([name, k]) => [name, k / n]),
      ),
      rateLimitedRefreshes: this.window.filter((r) => r.rateLimited > 0).length,
    };
  }
}
