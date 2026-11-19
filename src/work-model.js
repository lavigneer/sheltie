// The Work sidebar's model (#246): what work/main.js shows and acts on, with
// no View, timers or cx, so tests reach the real path.
//
// Owns the groups (repo -> hub + worktrees, from the store's scans), each
// row's last step, the folders of spaces still starting, the agents' costs
// and the store (WorkStore, work.js). The View draws view()'s rows, handles
// keys and clicks, and schedules scans and lookups.

import { agentIn, agentSaysDone, rowSteps, stillStarting } from "./flow.js";
import { hubExcept } from "./git.js";
import { spaceFor } from "./lib.js";
import { trackerOf } from "./tracker.js";
import { costIn } from "./usage.js";
import { WorkStore } from "./work.js";
import { workView } from "./work-rows.js";

// A row's space: a hub's leaves out its worktrees' folders (see spaceFor).
// `live`: the pass's snapshot (liveData).
export const spaceOf = (w, live) => spaceFor(w.path, w.except, live);

// spaceOf for one pass over the rows: one snapshot of Herdr's live data, and
// each row's space found once (a row asks for it several times).
export function spacesNow(live) {
  const found = new Map();
  return (w) => {
    const key = `${w.path}\0${w.except?.join("\0") ?? ""}`;
    if (!found.has(key)) found.set(key, spaceOf(w, live) ?? null);
    return found.get(key);
  };
}

// What the rows show of the agents' costs (usage groups): each folder's.
export const costsKey = (usage) =>
  JSON.stringify(usage?.map((g) => [g.dir, g.cost]) ?? null);

export class WorkModel {
  constructor({ store = new WorkStore() } = {}) {
    // null until the first scan; else every local repo:
    // [{ repo, hub: { path, branch, hub: true, except }, worktrees: [{ path, branch, repo, handle }] }]
    this.groups = null;
    this.mainCheckouts = new Set();
    this.store = store; // repo state, tickets and PRs (work.js)
    this.tickets = store.tickets; // by ticket key
    this.steps = new Map(); // worktree path -> { phase, text, at, staleAt }
    // Folders of spaces that appeared while we run, and when: their agent is
    // starting until it first works (or START_MS passes), so it isn't offered
    // Draft PR before it has begun the ticket.
    this.starting = new Map();
    this.usage = null; // usage groups (usage.js), for each row's agent cost
  }

  // Scans the repos' git state; true when it changed what is shown (the
  // groups are rebuilt only then: most scans find what the last one did).
  async scan(repos) {
    const was = this.store.version;
    await this.store.scan(repos);
    this.mainCheckouts = new Set(repos.map((r) => r.path));
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
            except: hubExcept(s.repo.path, s.linked),
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
  adopt(ref, pr) {
    if (!this.groups) return false;
    return this.store.adopt(
      this.groups.flatMap((g) => g.worktrees),
      ref,
      pr,
    );
  }

  // The ticket and PR lookups that are due (WorkStore.refresh). `changed()`
  // runs when one changed what is shown (a cache's version moved, or a
  // step's stale mark cleared); `tell(w, was, pr)` when a row's PR moved.
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
    const versions = () =>
      `${this.store.tickets.version}.${this.store.prs.version}`;
    let shown = versions();
    const changedIf = (cleared = false) => {
      const now = versions();
      if (!cleared && now === shown) return;
      shown = now;
      changed();
    };
    await this.store.refresh(keys, {
      force,
      view: true,
      // Worktrees whose branch names no ticket: their PR may name one.
      branches: all.filter((w) => !w.handle),
      onTicket: () => changedIf(),
      onPR: (ref, was, entry, asked) => {
        const pr = entry.value;
        let cleared = this.adopt(ref, pr);
        for (const w of all) {
          if (!this.store.ownsPR(w, ref, pr)) continue;
          if (entry.state === "found" && was) tell(w, was, pr);
          const last = this.steps.get(w.path);
          if (last?.staleAt <= asked) {
            delete last.staleAt;
            cleared = true;
          }
        }
        changedIf(cleared);
      },
    });
  }

  // A worktree's PR (WorkStore.rowFor); null for a hub or none known.
  prOf(w) {
    return w.hub ? null : this.store.rowFor(w).pr;
  }

  // The ticket's work everywhere (worktrees, branches, linked PRs), for a step.
  workOf(w) {
    return w.handle ? this.store.rowFor(w).items : [];
  }

  // Whether `w`'s branch names a ticket: only one the tracker says it doesn't
  // know (e.g. "UTF-8" in "fix-utf-8") isn't. Not looked up yet, or
  // unreachable: still a ticket.
  isTicket(w) {
    return (
      Boolean(w.handle) && this.tickets.get(w.handle.key)?.state !== "none"
    );
  }

  // Where `w`'s ticket is in the browser; null when its branch isn't a ticket.
  async ticketUrl(w) {
    return this.isTicket(w) ? await w.handle.url() : null;
  }

  // What the agents started in a row's folder have cost, in $, or null.
  costOf(w) {
    return this.usage ? costIn(this.usage, w.path) : null;
  }

  // Takes new usage groups; true when a row's cost moved.
  setUsage(usage) {
    const was = costsKey(this.usage);
    this.usage = usage;
    return costsKey(usage) !== was;
  }

  // The last step run on a row (unfaded: a report keeps its note), or null.
  lastOf(w) {
    const last = this.steps.get(w.path);
    return last
      ? { phase: last.phase, text: last.text, at: last.at ?? null }
      : null;
  }

  // A row's next steps (rowSteps).
  stepsOf(w, space, live) {
    return rowSteps({
      hub: w.hub,
      pr: this.prOf(w),
      lookup: w.hub ? null : this.store.prEntry(w.repo, w.branch),
      last: this.steps.get(w.path),
      status: space?.status,
      bornAt: this.starting.get(w.path),
      agentDone: agentSaysDone(space, live),
      repo: w.repo,
    });
  }

  // The groups shown: repos with worktrees, or whose hub has a space.
  shownGroups(spaceIn) {
    return (this.groups ?? []).filter(
      (g) => g.worktrees.length || spaceIn(g.hub),
    );
  }

  // Every folder the sidebar knows: main checkouts and worktrees.
  knownFolders() {
    return new Set([
      ...this.mainCheckouts,
      ...(this.groups ?? []).flatMap((g) => g.worktrees.map((w) => w.path)),
    ]);
  }

  // Forgets folders whose agent is no longer starting.
  settle(live, now) {
    for (const [f, born] of this.starting)
      if (!stillStarting(born, spaceFor(f, [], live)?.status, now))
        this.starting.delete(f);
  }

  // What the sidebar shows (work-rows.js) for Herdr's live data `live`
  // (liveData) at `now`, one pass over it; `ui` is the View's part: by,
  // folded, cap, expanded, width, confirm, picked. Adds active: the focused
  // space's id.
  view(live, now, ui = {}) {
    const active = live.local?.find((s) => s.active)?.id ?? null;
    const spaceIn = spacesNow(live);
    const view = workView({
      folded: new Set(),
      ...ui,
      groups: this.shownGroups(spaceIn),
      steps: this.steps,
      now,
      spaceOf: spaceIn,
      stepsOf: (w, space) => this.stepsOf(w, space, live),
      prOf: (w) => this.prOf(w),
      ticketOf: (w) => this.tickets.get(w.handle.key),
      isTicket: (w) => this.isTicket(w),
      costOf: (w) => this.costOf(w),
    });
    return { ...view, active };
  }

  // The report of the view's rows (view()), without the ticket URLs (null
  // until the View adds them, see ticketUrl). `extra`: the View's own fields
  // (renders).
  report(rows, live, now, extra = {}) {
    return {
      at: now,
      loaded: this.groups !== null,
      ...extra,
      rows: rows.map((r) => {
        const pr = r.prValue;
        const confirming = r.steps.find((s) => s.confirming)?.id ?? null;
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
          agent: agentIn(r.space, live),
          agentDone: agentSaysDone(r.space, live),
          cost: r.cost,
          selected: r.selected,
          step: r.selected
            ? Math.max(
                0,
                r.steps.findIndex((s) => s.chosen),
              )
            : null,
          steps: r.steps.map((s) => ({
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
          last: this.lastOf(r.w),
        };
      }),
    };
  }
}
