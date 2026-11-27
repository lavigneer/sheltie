// How long the Work sidebar's renders take (work.report's `renders`): a count,
// the mean, and the slowest few, each with its row count, its two halves
// (view: workView and live data; build: the elements) and what triggered it
// (the reason our last notify gave; "host": none, so Herdr re-rendered on its
// own). Kept in memory only.
//
// Two optional fields split the view half further: hostMs, the reads of Herdr's
// own state (spaces, theme), which are inside viewMs; and rebuilt, whether the
// render itself re-ran the store's join (WorkStore.snapshot), which a change
// that skipped wake() would cause.

export const SLOWEST = 5; // how many of the slowest renders to keep
export const SLOW_MS = 100; // a render this slow is recorded as a failure

/** @typedef {{ ms: number, viewMs: number, buildMs: number, rows: number, trigger: string, at?: number, hostMs?: number, rebuilt?: boolean }} Render */

export class RenderStats {
  constructor() {
    this.count = 0;
    this.totalMs = 0;
    /** @type {Render[]} */
    this.slowest = []; // slowest first
    /** @type {Record<string, number>} */
    this.byTrigger = {}; // trigger -> count
  }

  // Adds one render: { ms, viewMs, buildMs, rows, trigger }. True when it's
  // slower than SLOW_MS.
  /** @param {Render} r */
  add(r) {
    this.count++;
    this.totalMs += r.ms;
    this.byTrigger[r.trigger] = (this.byTrigger[r.trigger] ?? 0) + 1;
    if (
      this.slowest.length < SLOWEST ||
      r.ms > this.slowest[this.slowest.length - 1].ms
    ) {
      this.slowest.push({ ...r, at: r.at ?? Date.now() });
      this.slowest.sort((a, b) => b.ms - a.ms);
      this.slowest.length = Math.min(this.slowest.length, SLOWEST);
    }
    return r.ms > SLOW_MS;
  }

  // For work.report.
  report() {
    return {
      count: this.count,
      meanMs: this.count ? this.totalMs / this.count : null,
      byTrigger: { ...this.byTrigger },
      slowest: this.slowest.map((r) => ({ ...r })),
    };
  }
}
