// How long the Work sidebar's renders take (work.report's `renders`): a count,
// the mean, the last render and the slowest few, each with its row count,
// how many elements it built (nodes), its two halves
// (view: workView and live data; build: the elements) and what triggered it
// (the reason our last notify gave; "host": none, so Herdr re-rendered on its
// own). Kept in memory only.

export const SLOWEST = 5; // how many of the slowest renders to keep
export const SLOW_MS = 100; // a render this slow is recorded as a failure

export class RenderStats {
  constructor() {
    this.count = 0;
    this.totalMs = 0;
    this.slowest = []; // slowest first
    this.byTrigger = {}; // trigger -> count
    this.last = null;
  }

  // Adds one render: { ms, viewMs, buildMs, rows, nodes, trigger }. True when it's
  // slower than SLOW_MS.
  add(r) {
    this.count++;
    this.last = { ...r, at: r.at ?? Date.now() };
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
      last: this.last && { ...this.last },
      slowest: this.slowest.map((r) => ({ ...r })),
    };
  }
}
