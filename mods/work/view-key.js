// The Work sidebar's view data (workView) is reused while nothing it reads
// changed: Herdr often re-renders a mod several times for one change, and most
// of those renders show the same thing. viewKey() fingerprints every input in
// O(live data + steps), with no joins and no per-row reads; ViewMemo keeps the
// last view and computes a new one only when the fingerprint moves.
//
// Elements can't be kept (gpui-kit forbids storing one), so this saves only
// the data half of a render.

// What view() reads, as one string. `x`:
//   versions   [store.version, tickets, linked, prs]: bumped when what they hold changes
//   live       liveData(): each local space's id, folder, status, active and
//              tab ids; each pane's tab, cwd, terminal and program key; each
//              terminal's address and agent / pr labels; each agent's space
//              and address
//   nav        Nav: folds, expanded groups, the pick
//   confirm    nav.confirming(now): the step waiting for its second press
//   steps      worktree path -> { phase, text, at, staleAt }
//   starting   folder -> when its space appeared
//   now, noteMs, startMs   a done step's note fades after noteMs; a space
//              stops starting after startMs (only which side of each counts)
//   rest       anything else plain (width, grouping, settings, costs key)
export function viewKey(x) {
  const { live, nav, now } = x;
  const spaces = live.local.map((s) => [
    s.id,
    s.folder ?? null,
    s.status ?? null,
    Boolean(s.active),
    (s.tabs ?? []).map((t) => t.id),
  ]);
  const panes = live.panes.map((p) => [
    p.tab,
    p.cwd ?? null,
    p.terminal ?? null,
    p.program?.key ?? null,
  ]);
  const terminals = live.terminals.map((t) => [
    t.address,
    t.labels?.agent ?? null,
    t.labels?.pr ?? null,
  ]);
  const agents = live.agents.map((a) => [a.space, a.address]);
  const steps = [...x.steps].map(([path, s]) => [
    path,
    s.phase,
    s.text,
    s.at ?? null,
    s.staleAt ?? null,
    s.phase === "done" && now - s.at > x.noteMs,
  ]);
  const starting = [...x.starting].map(([f, born]) => [
    f,
    now - born < x.startMs,
  ]);
  return JSON.stringify([
    x.versions,
    spaces,
    panes,
    terminals,
    agents,
    [...nav.folded],
    [...nav.expanded],
    nav.pick ?? null,
    x.confirm?.id ?? null,
    steps,
    starting,
    x.rest,
  ]);
}

// The last view and its key: get() returns it while the key stays.
export class ViewMemo {
  constructor() {
    this.key = null;
    this.value = null;
  }

  get(key, compute) {
    if (key !== this.key) {
      this.value = compute();
      this.key = key;
    }
    return this.value;
  }
}
