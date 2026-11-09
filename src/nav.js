// The Work sidebar's navigation state: which row and step the keys act on,
// which groups are folded, and the step waiting for its second press. Pure:
// callers pass the shown rows ([{ path, steps, active }], steps: the row's
// next steps, active: whether its space is focused), the focused space's id
// and the time, so this runs without Herdr.

import { cycle } from "./lib.js";

export const CONFIRM_MS = 4_000;

export class Nav {
  constructor() {
    this.folded = new Set(); // repo paths
    this.picked = null; // { path, step, active }: the row the keys moved to
    this.pending = null; // { id, byKey, until }: see press()
  }

  // The selected row and step: the one the keys moved to while the same space
  // stays focused, else the focused space's row, else the first.
  // { at, step } (at: -1 without rows; step clamped to the row's steps).
  select(rows, active) {
    if (this.picked && this.picked.active !== active) this.picked = null;
    let at = this.picked
      ? rows.findIndex((r) => r.path === this.picked.path)
      : -1;
    let step = at >= 0 ? this.picked.step : 0;
    if (at < 0) {
      at = rows.findIndex((r) => r.active);
      if (at < 0 && rows.length) at = 0;
      step = 0;
    }
    const n = rows[at]?.steps.length ?? 0;
    return { at, step: n ? Math.min(step, n - 1) : 0 };
  }

  // Moves the selection: "next" / "prev" through the rows, "step-next" /
  // "step-prev" through the selected row's steps.
  move(rows, active, c) {
    const { at, step } = this.select(rows, active);
    const pick = (i, s) => {
      if (rows[i]) this.picked = { path: rows[i].path, step: s, active };
    };
    if (c === "next" || c === "prev") {
      if (rows.length) pick(cycle(rows.length, at, c === "next" ? 1 : -1), 0);
    } else {
      const n = rows[at]?.steps.length ?? 0;
      if (n) pick(at, cycle(n, step, c === "step-next" ? 1 : -1));
    }
  }

  isFolded(repo) {
    return this.folded.has(repo);
  }

  // Folds or unfolds the group of repo `repo` (its hub's path), whose
  // worktrees are `paths`. Folding the group the keys picked a worktree in
  // moves the pick to its hub, which stays shown.
  fold(repo, paths) {
    if (this.folded.delete(repo)) return;
    this.folded.add(repo);
    if (this.picked && paths.includes(this.picked.path))
      this.picked = { ...this.picked, path: repo, step: 0 };
  }

  // A press of step `id` (unique across rows); one that `asks` runs on its
  // second press within CONFIRM_MS. Whether to run it now.
  press(id, asks, byKey, now) {
    if (asks && this.confirming(now)?.id !== id) {
      this.pending = { id, byKey, until: now + CONFIRM_MS };
      return false;
    }
    this.pending = null;
    return true;
  }

  // The step waiting for its second press at `now`: { id, byKey } or null.
  confirming(now) {
    return this.pending && now < this.pending.until ? this.pending : null;
  }
}
