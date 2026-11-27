// The Work sidebar's model (#246): what work/main.js shows and acts on, with
// no View, timers or cx, so tests reach the real path.
//
// Owns the groups (repo -> hub + worktrees, from the store's scans), each
// row's last step, the new spaces' folders (arrivals, below), the agents' costs,
// the navigation state (Nav, nav.js), and the store (WorkStore, work.js).
// step() presses a row's next step and runs it; events() says what a PR's
// change should notify. Both return data: the View does the herdr calls.
// The View draws view()'s rows, handles keys and clicks, and schedules scans
// and lookups.

import { recordFailure } from "./diagnostics.js";
import { errorMessage } from "./errors.js";
import {
  clearStale,
  prEvents,
  rowSteps,
  runStep,
  STEP,
  stepDone,
  stepFailed,
  stepRunning,
  stepState,
  stillStarting,
} from "./flow.js";
import { hubExcept, sameSlug } from "./git.js";
import { basename } from "./lib.js";
import { Nav } from "./nav.js";
import { trackerOf } from "./tracker.js";
import { costIn } from "./usage.js";
import { WorkStore } from "./work.js";
import { workView } from "./work-rows.js";

// A row's space: a hub's leaves out its worktrees' folders (see spaceOf in
// spaces.js). `live`: the pass's snapshot (herdrSpaces).
export const spaceOf = (/** @type {any} */ w, /** @type {any} */ live) =>
  live.spaceOf(w.path, w.except);

// What a row is called in notifications: its ticket's label, else its folder.
export const whoOf = (/** @type {any} */ w) =>
  w.handle?.label ?? basename(w.path);

// Rechecks of a new space's folder before we give up on it (the 30 s poll
// still lists it later).
export const WATCH_TRIES = 3;

// What the rows show of the agents' costs (usage groups): each folder's.
export const costsKey = (/** @type {any} */ usage) =>
  JSON.stringify(usage?.map((/** @type {any} */ g) => [g.dir, g.cost]) ?? null);

// `prs` in stack order, bottom first: each PR after the one whose head branch
// it is based on (its base). A PR whose base is none of them starts a chain;
// siblings keep number order, and a cycle (none starts it) is walked by number.
export function stackOrder(/** @type {any} */ prs) {
  const sorted = [...prs].sort((a, b) => a.number - b.number);
  const byBranch = new Map(sorted.map((p) => [p.branch, p]));
  const above = new Map(); // PR number -> the PRs based on it
  const roots = [];
  for (const p of sorted) {
    const under = p.base ? byBranch.get(p.base) : undefined;
    if (under && under !== p)
      above.set(under.number, [...(above.get(under.number) ?? []), p]);
    else roots.push(p);
  }
  /** @type {any[]} */
  const out = [];
  const seen = new Set();
  const walk = (/** @type {any} */ p) => {
    if (seen.has(p.number)) return;
    seen.add(p.number);
    out.push(p);
    for (const k of above.get(p.number) ?? []) walk(k);
  };
  for (const p of [...roots, ...sorted]) walk(p);
  return out;
}

export class WorkModel {
  constructor({ store = new WorkStore(), nav = new Nav() } = {}) {
    // null until the first scan; else every local repo:
    // [{ repo, hub: { path, branch, hub: true, except }, worktrees: [{ path, branch, repo, handle }] }]
    this.groups = null;
    this.mainCheckouts = new Set();
    this.store = store; // repo state, tickets and PRs (work.js)
    this.tickets = store.tickets; // by ticket key
    // The folds, the picked row and step, and a step awaiting its second press
    // (nav.js). The View reads and moves them; step() presses them.
    this.nav = nav;
    this.steps = new Map(); // worktree path -> its last step (flow.js: STEP)
    // The new spaces' folders: folder -> { watch, tries, bornAt }. `watch` is
    // "watching" (not yet a listed worktree; rechecked after each scan, up to
    // WATCH_TRIES times), "gave up" (still not listed after that; the 30 s
    // poll covers it) or "listed". `bornAt`: when its space appeared, while its
    // agent is starting (until it first works or START_MS passes), so it isn't
    // offered Draft PR before it has begun the ticket; null once it isn't.
    // An entry goes once it is listed and no longer starting.
    this.arrivals = new Map();
    this.usage = null; // usage groups (usage.js), for each row's agent cost
    // Bumped by what the store's versions don't cover: an adoption, a step's
    // stale mark clearing, a cost moving.
    this.edits = 0;
  }

  // What is shown, as one value: it moves whenever a render would differ
  // (the store's scan, its ticket, linked-PR and PR caches, and edits).
  get revision() {
    const s = this.store;
    return `${s.version}.${s.tickets.version}.${s.linked.version}.${s.prs.version}.${this.edits}`;
  }

  // Scans the repos' git state; true when it changed what is shown (the
  // groups are rebuilt only then: most scans find what the last one did).
  async scan(/** @type {any} */ repos) {
    const was = this.store.version;
    await this.store.scan(repos);
    this.mainCheckouts = new Set(repos.map((/** @type {any} */ r) => r.path));
    // The groups follow the scan only; lookups move the revision themselves.
    const changed = this.groups === null || this.store.version !== was;
    if (changed)
      this.groups = this.store.states.flatMap((s) => {
        if (!s) return [];
        const t = trackerOf(s.repo); // once per repo, not per worktree
        return {
          repo: s.repo,
          hub: {
            path: s.repo.path,
            branch: s.mainBranch,
            hub: true,
            except: hubExcept(/** @type {string} */ (s.repo.path), s.linked),
          },
          worktrees: s.worktrees.map((w) => {
            const row = { ...w, repo: s.repo };
            return { ...row, handle: this.store.rowFor(row, t).handle };
          }),
        };
      });
    return changed;
  }

  // Gives worktrees whose branch names no ticket the one their PR (just
  // looked up as `ref`) names (WorkStore.adopt). True when one changed.
  adopt(/** @type {any} */ ref, /** @type {any} */ pr) {
    if (!this.groups) return false;
    const changed = this.store.adopt(
      this.groups.flatMap((g) => g.worktrees),
      ref,
      pr,
    );
    if (changed) this.edits++;
    return changed;
  }

  // The ticket and PR lookups that are due (WorkStore.refresh). `changed()`
  // runs when one moved the revision (a ticket, linked PR or PR changed, a
  // branch adopted a ticket, or a step's stale mark cleared); `tell(w, was, pr)` when a row's PR moved.
  /** @param {boolean} [force] @param {{ changed?: () => void, tell?: (w: any, was: any, pr: any) => void }} [on] */
  async lookups(force, { changed = () => {}, tell = () => {} } = {}) {
    if (!this.groups) return;
    const all = this.groups.flatMap((g) =>
      g.worktrees.map((w) => ({ ...w, repo: g.repo })),
    );
    // Each key once, with the tracker of the repo it's from.
    const keys = new Map(
      all.flatMap((w) => (w.handle ? [[w.handle.key, w.handle.tracker]] : [])),
    );
    let shown = this.revision;
    const moved = () => {
      if (this.revision === shown) return;
      shown = this.revision;
      changed();
    };
    await this.store.refresh(keys, {
      force,
      view: true,
      // Worktrees whose branch names no ticket: their PR may name one.
      branches: all.filter((w) => !w.handle),
      onTicket: moved,
      onLinked: moved,
      onPR: (ref, was, entry, asked) => {
        const pr = entry.value;
        this.adopt(ref, pr);
        for (const w of all) {
          if (!this.store.ownsPR(w, ref, pr)) continue;
          if (entry.state === "found" && was) tell(w, was, pr);
          if (clearStale(this.steps.get(w.path), asked)) this.edits++;
        }
        moved();
      },
    });
  }

  // A worktree's PR (WorkStore.rowFor); null for a hub or none known.
  prOf(/** @type {any} */ w) {
    return w.hub ? null : this.store.rowFor(w).pr;
  }

  // The ticket's work everywhere (worktrees, branches, linked PRs), for a step.
  workOf(/** @type {any} */ w) {
    return w.handle ? this.store.rowFor(w).items : [];
  }

  // The ticket's other PRs in `w`'s repo (a gh stack, or earlier PRs from
  // the same worktree), in stack order (stackOrder), the row's own PR
  // placed among them: the row shows them beside its own.
  stackOf(/** @type {any} */ w) {
    const own = this.prOf(w);
    const seen = new Map();
    for (const p of [own, ...this.workOf(w).map((i) => i.pr)])
      if (p && sameSlug(p.slug, w.repo.slug)) seen.set(p.number, p);
    return stackOrder([...seen.values()]).filter(
      (p) => p.number !== own?.number,
    );
  }

  // Whether `w`'s branch names a ticket: only one the tracker says it doesn't
  // know (e.g. "UTF-8" in "fix-utf-8") isn't. Not looked up yet, or
  // unreachable: still a ticket.
  isTicket(/** @type {any} */ w) {
    return (
      Boolean(w.handle) && this.tickets.get(w.handle.key)?.state !== "none"
    );
  }

  // Where `w`'s ticket is in the browser; null when its branch isn't a ticket.
  async ticketUrl(/** @type {any} */ w) {
    return this.isTicket(w) ? await w.handle.url() : null;
  }

  // What the agents started in a row's folder have cost, in $, or null.
  costOf(/** @type {any} */ w) {
    return this.usage ? costIn(this.usage, w.path) : null;
  }

  // Takes new usage groups; true when a row's cost moved.
  setUsage(/** @type {any} */ usage) {
    const was = costsKey(this.usage);
    this.usage = usage;
    if (costsKey(usage) === was) return false;
    this.edits++;
    return true;
  }

  // The last step run on a row (unfaded: a report keeps its note), or null.
  lastOf(/** @type {any} */ w) {
    const last = this.steps.get(w.path);
    return last
      ? { phase: last.phase, text: last.text, at: last.at ?? null }
      : null;
  }

  // Presses a row's next step `step` (from rowSteps). Returns what the View
  // does next, with no herdr calls of its own:
  //   { outcome: "running" }          it is already running: nothing to do
  //   { outcome: "confirm", until }   a first press of a step that asks; its
  //                                   second press (within CONFIRM_MS) runs it
  //   { outcome: "run", done }        it runs; `done` resolves to { notices,
  //                                   fades } once it answers. notices: for
  //                                   herdr's notify; fades: its note fades
  //                                   (NOTE_MS) rather than staying (failed)
  // byKey: a key press, not a click (Nav.press). now: ms.
  /** @returns {{ outcome: "running" } | { outcome: "confirm", until: number } | { outcome: "run", done: Promise<{ notices: { title: string, body?: string, level: "success" | "error" | "warning" | "info" }[], fades: boolean }> }} */
  step(
    /** @type {any} */ w,
    /** @type {any} */ step,
    { byKey = false, now = Date.now() } = {},
  ) {
    const path = w.path;
    if (stepState(this.steps.get(path)) === STEP.RUNNING)
      return { outcome: "running" };
    const id = `${path}:${step.id}`;
    if (!this.nav.press(id, Boolean(step.confirm), byKey, now))
      return { outcome: "confirm", until: this.nav.pending?.until ?? now };
    this.steps.set(path, stepRunning(`${step.label}…`));
    const pr = this.prOf(w);
    // The ticket's work everywhere: worktrees and branches here, and the PRs
    // its tracker links (in repos with no worktree here too).
    const work = this.workOf(w);
    const who = whoOf(w);
    const done = runStep(step.id, w, pr, work).then(
      (/** @type {string} */ note) => {
        this.steps.set(path, stepDone(note, Date.now()));
        const notices =
          step.kind === "direct"
            ? [
                {
                  title: `${who}: ${step.label}`,
                  body: note,
                  level: /** @type {const} */ ("success"),
                },
              ]
            : [];
        return { notices, fades: true };
      },
      (/** @type {any} */ e) => {
        const text = `${errorMessage(e)}`.split("\n")[0];
        this.steps.set(path, stepFailed(text, Date.now()));
        recordFailure("work", step.label, e, { path });
        return {
          notices: [
            {
              title: `${who}: ${step.label} failed`,
              body: text,
              level: /** @type {const} */ ("error"),
            },
          ],
          fades: false,
        };
      },
    );
    return { outcome: "run", done };
  }

  // The notifications for a row whose PR moved from `was` to `pr` (prEvents),
  // each with the action that selects the row's space. `live`: spaces.js.
  events(
    /** @type {any} */ w,
    /** @type {any} */ was,
    /** @type {any} */ pr,
    /** @type {any} */ live,
  ) {
    const who = whoOf(w);
    const space = spaceOf(w, live);
    const action = space
      ? { name: "space.select", args: { id: space.id } }
      : undefined;
    return prEvents(was, pr).map(({ title, level, body }) => ({
      title: `${who}: ${title}`,
      body,
      level,
      action,
    }));
  }

  // A row's next steps (rowSteps).
  stepsOf(
    /** @type {any} */ w,
    /** @type {any} */ space,
    /** @type {any} */ live,
  ) {
    return rowSteps({
      hub: w.hub,
      pr: this.prOf(w),
      lookup: w.hub ? null : this.store.prEntry(w.repo, w.branch),
      last: this.steps.get(w.path),
      status: space?.status,
      bornAt: this.arrivals.get(w.path)?.bornAt ?? null,
      agentDone: live.agentDone(space),
      repo: w.repo,
    });
  }

  // The groups shown: repos with worktrees, or whose hub has a space.
  shownGroups(/** @type {any} */ live) {
    return (this.groups ?? []).filter(
      (g) => g.worktrees.length || spaceOf(g.hub, live),
    );
  }

  // Every folder the sidebar knows: main checkouts and worktrees.
  knownFolders() {
    return new Set([
      ...this.mainCheckouts,
      ...(this.groups ?? []).flatMap((g) => g.worktrees.map((w) => w.path)),
    ]);
  }

  // Folders of local spaces that are neither known worktrees nor already
  // arrivals: they start watching now, and their agent starts. Returns them
  // (the View schedules the timers). `live`: spaces.js; `now`: ms.
  arrive(/** @type {any} */ live, /** @type {any} */ now) {
    if (!this.groups) return [];
    const known = this.knownFolders();
    const fresh = live.local
      .filter((/** @type {any} */ s) => s.folder)
      .map((/** @type {any} */ s) => s.folder.replace(/\/+$/, ""))
      .filter((/** @type {any} */ f) => !known.has(f) && !this.arrivals.has(f));
    for (const f of fresh)
      this.arrivals.set(f, { watch: "watching", tries: 0, bornAt: now });
    return fresh;
  }

  // Whether any folder is still being watched (the next scan lists local repos
  // again for it: they may be a new clone).
  watching() {
    return [...this.arrivals.values()].some((a) => a.watch === "watching");
  }

  // After a scan: a listed folder is listed; a watched one that still isn't
  // gets another try, or gives up after WATCH_TRIES.
  recheck() {
    const known = this.knownFolders();
    for (const [f, a] of this.arrivals) {
      if (a.watch === "listed") continue;
      if (known.has(f)) a.watch = "listed";
      else if (a.watch === "gave up") continue;
      else if (a.tries + 1 < WATCH_TRIES) a.tries++;
      else a.watch = "gave up";
    }
  }

  // Ends each arrival's starting window once its agent works or START_MS has
  // passed, and forgets the listed ones that are no longer starting.
  settle(/** @type {any} */ live, /** @type {any} */ now) {
    for (const [f, a] of this.arrivals) {
      if (
        a.bornAt != null &&
        !stillStarting(a.bornAt, live.spaceOf(f)?.status, now)
      )
        a.bornAt = null;
      if (a.watch === "listed" && a.bornAt == null) this.arrivals.delete(f);
    }
  }

  // What the sidebar shows (work-rows.js) for Herdr's live data `live`
  // (spaces.js) at `now`, one pass over it; `ui` is the View's part: by,
  // folded, cap, expanded, width, confirm, picked. Adds active: the focused
  // space's id.
  view(/** @type {any} */ live, /** @type {any} */ now, ui = {}) {
    const active = live.active;
    const view = workView({
      folded: new Set(),
      ...ui,
      groups: this.shownGroups(live),
      steps: this.steps,
      now,
      spaceOf: (/** @type {any} */ w) => spaceOf(w, live),
      stepsOf: (/** @type {any} */ w, /** @type {any} */ space) =>
        this.stepsOf(w, space, live),
      prOf: (/** @type {any} */ w) => this.prOf(w),
      stackOf: (/** @type {any} */ w) => (w.hub ? [] : this.stackOf(w)),
      ticketOf: (/** @type {any} */ w) => this.tickets.get(w.handle.key),
      isTicket: (/** @type {any} */ w) => this.isTicket(w),
      costOf: (/** @type {any} */ w) => this.costOf(w),
    });
    return { ...view, active };
  }

  // The report of the view's rows (view()), without the ticket URLs (null
  // until the View adds them, see ticketUrl). `extra`: the View's own fields
  // (renders).
  report(
    /** @type {any} */ rows,
    /** @type {any} */ live,
    /** @type {any} */ now,
    extra = {},
  ) {
    return {
      at: now,
      loaded: this.groups !== null,
      ...extra,
      rows: rows.map((/** @type {any} */ r) => {
        const pr = r.prValue;
        const confirming =
          r.steps.find((/** @type {any} */ s) => s.confirming)?.id ?? null;
        return {
          path: r.w.path,
          hub: r.hub,
          branch: r.w.branch,
          key: r.w.handle?.key ?? null,
          repo: r.w.repo.slug ?? r.w.repo.name,
          space: r.space?.id ?? null,
          // The status dot: working, blocked… (null: no space).
          status: r.space?.status ?? null,
          // What the row's status shows (null: the working spinner).
          glyph: r.status.glyph,
          title: r.title,
          sub: r.sub,
          agent: live.agentIn(r.space),
          agentDone: live.agentDone(r.space),
          cost: r.cost,
          selected: r.selected,
          step: r.selected
            ? Math.max(
                0,
                r.steps.findIndex((/** @type {any} */ s) => s.chosen),
              )
            : null,
          steps: r.steps.map((/** @type {any} */ s) => ({
            id: s.id,
            label: s.label,
            confirm: Boolean(s.confirm),
          })),
          confirming,
          ticket: r.ticket,
          ticketUrl: null,
          prUrl: pr?.url ?? null,
          pr: pr && {
            number: pr.number,
            label: r.pr?.text ?? null,
            state: pr.state,
            draft: pr.draft,
            review: pr.review,
            checks: pr.checks,
            autoMerge: pr.autoMerge,
            mergeable: pr.mergeable,
            unresolved: pr.unresolved ?? null,
          },
          stack: r.stack.map((/** @type {any} */ p) => ({
            number: p.number,
            label: p.text,
            state: p.state,
            title: p.title,
            url: p.url,
            selected: p.selected,
          })),
          last: this.lastOf(r.w),
        };
      }),
    };
  }
}
