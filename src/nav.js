// The Work sidebar's navigation state, and every change to it: which groups
// are folded, the row and step the keys moved to, and the step waiting for its
// second press. Pure: callers pass the focused space's id, the shown rows and
// the time, so this runs without Herdr. workView (work-rows.js) turns it into
// the selected row and step.

import { cycle } from "./lib.js";

export const CONFIRM_MS = 4_000;

export class Nav {
  constructor() {
    this.folded = new Set(); // repo paths
    this.pick = null; // { path, step, active }: see picked()
    this.pending = null; // { id, byKey, until }: see press()
  }

  // The row and step the keys moved to ({ path, step }), while the space
  // focused then (`active`, its id) stays focused; else null, for good.
  picked(active) {
    if (this.pick && this.pick.active !== active) this.pick = null;
    return this.pick;
  }

  // Moves the selection from row `at`, step `step` of `rows` ([{ path,
  // steps }], steps: the row's next steps): "next" / "prev" through the
  // rows, "step-next" / "step-prev" through the selected row's steps.
  move(rows, at, step, active, c) {
    const to = (i, s) => {
      if (rows[i]) this.pick = { path: rows[i].path, step: s, active };
    };
    if (c === "next" || c === "prev") {
      if (rows.length) to(cycle(rows.length, at, c === "next" ? 1 : -1), 0);
    } else {
      const n = rows[at]?.steps.length ?? 0;
      if (n) to(at, cycle(n, step, c === "step-next" ? 1 : -1));
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
    if (this.pick && paths.includes(this.pick.path))
      this.pick = { ...this.pick, path: repo, step: 0 };
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
