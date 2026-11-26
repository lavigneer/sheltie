// The Work sidebar's navigation state, and every change to it: which groups
// are folded, the row and step the keys moved to, and the step waiting for its
// second press. Pure: callers pass the focused space's id, the shown rows and
// the time, so this runs without Herdr. workView (work-rows.js) turns it into
// the selected row and step.

import { cycle } from "./lib.js";

export const CONFIRM_MS = 4_000;

// The groups folded until unfolded: grouped by stage, Merged and Closed (their
// rows rarely need you). Stage keys as stageKey() (work-rows.js) makes them.
export const FOLDED = ["stage:merged", "stage:closed"];

export class Nav {
  constructor(folded = FOLDED) {
    this.folded = new Set(folded); // group keys: repo paths or stage keys
    this.expanded = new Set(); // repo paths showing past their cap ("+k more")
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

  // Folds or unfolds the group `key` (a repo's: its hub's path), whose
  // worktrees are `paths`. Folding the group the keys picked a worktree in
  // moves the pick to `home`, the row that stays shown (a repo's hub), or
  // drops it when there is none (a stage group).
  fold(key, paths, home = key) {
    if (this.folded.delete(key)) return;
    this.folded.add(key);
    if (this.pick && paths.includes(this.pick.path))
      this.pick = home ? { ...this.pick, path: home, step: 0 } : null;
  }

  // Shows all of repo group `key`'s worktrees past its cap, or back to the cap.
  expand(key) {
    if (!this.expanded.delete(key)) this.expanded.add(key);
  }

  // A press of step `id` (unique across rows); one that `asks` runs on its
  // second press within CONFIRM_MS. Whether to run it now.
  press(id, asks, byKey, now) {
    if (asks && !this.armed(id, now)) {
      this.pending = { id, byKey, until: now + CONFIRM_MS };
      return false;
    }
    this.pending = null;
    return true;
  }

  // Whether step `id` is armed at `now`: its first press is waiting for the
  // second, so the next press of it runs.
  armed(id, now) {
    return this.confirming(now)?.id === id;
  }

  // The step waiting for its second press at `now`: { id, byKey } or null.
  // For the look of the wait (byKey: a key press, not a click); use armed().
  confirming(now) {
    return this.pending && now < this.pending.until ? this.pending : null;
  }
}
