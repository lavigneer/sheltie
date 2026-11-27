// Work: a repo -> worktree outline for the Herdr sidebar.
//
// Every worktree of your local repos (open in a space or not), grouped by repo.
// Each group's header is also the repo's hub: its main checkout, with a space of its
// own for the repo's longer-running agents (no ticket, PR or steps). A repo
// shows while it has worktrees or its hub has a space.
// A row shows the ticket its branch names (key, summary, status), its pull
// request (review and checks) and the agent status of its space. Click a row to
// go to its space, or to open one there (with the agent; a hub's opens without). Its ↗ button (shown on
// hover, on the selected row and while its menu is open) opens a menu: Open PR,
// Open ticket (in the browser), each only when the row has one. Its second
// line ends with what agents working in its folder have cost (usage.js).
// "+" opens the tickets popup to start new work; ↻ refreshes everything now.
//
// Under a row, its ticket's other PRs in the repo (a stack), one indented
// sub-item each: selectable like a row; a click, work.open or work.open-pr
// opens that PR in the browser. They have no steps or space of their own.
//
// Under each row, buttons for its next step in the ticket workflow (Draft PR,
// Fix CI, Address comments, Resolve conflicts, Ready, Merge, Finish; see
// flow.js). Finish and Clean up ask for a second click. Notifies you when CI
// finishes, review comments or a review arrive, the PR starts conflicting
// with its base, or it merges.
//
// Keys (keys.json; delivered through nextCommand()): one row is selected,
// the focused space's by default. work.next / work.prev move the selection
// through the shown rows, work.step-next / work.step-prev pick one of its
// next steps (the first by default), work.step runs that step (Finish and
// Clean up: press twice) and work.open opens the row's space, like a click.
// work.open-pr / work.open-ticket open the row's PR / ticket in the browser,
// like its ↗ menu's Open PR / Open ticket (a hub: says there's
// nothing to open).
// work.group switches between grouping by repo and by PR stage, like ▤
// (C.workGroupBy sets which it opens with).
// work.refresh refreshes everything now, like ↻. work.report writes what the
// sidebar shows to <app home>/work-report.json, for scripts and tests, with
// how long its renders take (renders.js).
// work.start starts the tickets the requests in <app home>/work-start/ name,
// like the tickets popup (for agents and scripts; see drainRequests).
//
// State (groups, store, steps, starting folders, costs and the step rules live
// in WorkModel, work-model.js, which tests reach without a View):
//   git refresh, details   each runs one at a time; a request during a run
//                          queues one more (serial(), watch.js), merging "force"
//   store                  repo state, plus caches (WorkStore, work.js) of tickets,
//                          tracker-linked PRs and PR details: { state: "found" |
//                          "none" | "failed", value, at }; "failed" (tracker/GitHub
//                          unreachable) is retried after a minute, never shown as "none"
//   steps                  per worktree: the last step run from here
//                          (running / done / failed, with a note)
//   nav                    folded groups, the row and step the keys moved to
//                          (dropped when the focused space changes) and the
//                          step waiting for its second press (Nav, nav.js)
//   arrivals               (work-model.js) the folders of new spaces: watched
//                          until listed as worktrees, rechecked a few times
//                          (the tickets popup makes the worktree first; an
//                          agent may make it later), and their agent's
//                          starting window
//   awaiting               (work-model.js) the worktrees a scan listed for the
//                          first time, until each has a space (or START_MS):
//                          rendered every WATCH_MS meanwhile, as nothing else
//                          renders when Herdr opens the space
// Git refreshes every 30 s and at once for a new space; PRs every 2 min (20 s
// while CI runs or a merge is pending), tickets and their linked PRs every
// 10 min (the rules live in work.js).

import { v_flex } from "gpui-base";
import { View } from "gpui-kit";
import {
  appHome,
  nextCommand,
  notify,
  readTextFile,
  run,
  theme,
  writeTextFile,
} from "herdr";
import { C, configReady } from "./config.js";
import { recordFailure } from "./diagnostics.js";
import { errorMessage } from "./errors.js";
import { START_MS } from "./flow.js";
import { openUrl } from "./lib.js";
import { CONFIRM_MS, Nav } from "./nav.js";
import { RepoCache } from "./polling.js";
import { RenderStats } from "./renders.js";
import { resize } from "./sidebar.js";
import { herdrSpaces } from "./spaces.js";
import { drainRequests } from "./start.js";
import { usageGroups } from "./usage.js";
import { serial } from "./watch.js";
import { spaceOf, WorkModel, whoOf } from "./work-model.js";
import { bodyEl, fit, headerEl, messageEl, NOTE_MS } from "./work-rows.js";

const GIT_MS = 30_000;
const DUE_CHECK_MS = 10_000; // how often to look for due lookups
const USAGE_MS = 120_000; // agent costs (see usage.js)
const WATCH_MS = 3_000; // between rechecks of a new space's folder

export default class Work extends View {
  /** @type {number | null} */
  width = null;
  /** @type {ReturnType<typeof serial>} */
  refresh = /** @type {any} */ (undefined);
  /** @type {ReturnType<typeof serial>} */
  details = /** @type {any} */ (undefined);
  /** @type {ReturnType<typeof serial>} */
  starts = /** @type {any} */ (undefined);
  /** @type {ReturnType<typeof serial>} */
  costs = /** @type {any} */ (undefined);
  /** @type {WorkModel} */
  model = /** @type {any} */ (undefined);
  /** @type {Nav} */
  nav = /** @type {any} */ (undefined);
  /** @type {RepoCache} */
  repos = /** @type {any} */ (undefined);
  /** @type {boolean} */
  watchTimer = /** @type {any} */ (undefined);
  /** @type {boolean} */
  awaitTimer = /** @type {any} */ (undefined);
  /** @type {RenderStats} */
  renders = /** @type {any} */ (undefined);
  init(/** @type {any} */ _props, /** @type {any} */ cx) {
    // Groups, steps, starting folders, costs and the store (work-model.js).
    this.model = new WorkModel();
    this.nav = this.model.nav; // folds, picked row and step, confirm (nav.js)
    /** @type {string | null} */
    this.by = null; // "repo" | "stage"; null: C.workGroupBy (once loaded)
    this.repos = new RepoCache(); // the local repos (polling.js)
    this.hovered = null; // the path of the row under the pointer
    this.linksOpen = null; // the path of the row whose ↗ menu is open
    this.watchTimer = false;
    this.awaitTimer = false; // a render is due for a new worktree's space
    /** @type {number | null} */
    this.width = null; // ours, from on_size_change
    this.renders = new RenderStats(); // render timings, for work.report
    /** @type {string | null} */
    this.why = null; // what the next render is for (wake); null: Herdr's own
    this.refresh = serial((cx, force) => this.scan(cx, force));
    this.details = serial((cx, force) => this.lookups(cx, force));
    this.refresh(cx);
    cx.timer.every(GIT_MS, (/** @type {any} */ cx) => this.refresh(cx));
    // Ticket/PR lookups that are due, between git scans (only due ones run).
    cx.timer.every(DUE_CHECK_MS, (/** @type {any} */ cx) => this.details(cx));
    // work.start: every request waiting in <app home>/work-start (see
    // drainRequests, start.js), one run at a time.
    this.starts = serial(async (cx) => {
      await configReady();
      await drainRequests(`${appHome()}/work-start`).catch((e) => {
        console.error(`work.start: ${errorMessage(e)}`);
        recordFailure("work.start", "drain requests", e);
      });
      this.refresh(cx, true);
    });
    this.costs = serial(async (cx) => {
      await configReady();
      const usage = await usageGroups().catch((e) => {
        console.error(`work: ${errorMessage(e)}`);
        recordFailure("work", "usage", e);
        return this.model.usage;
      });
      // Rows show each folder's cost: re-render only when one moved.
      if (this.model.setUsage(usage)) this.wake(cx, "costs");
    });
    this.costs(cx);
    cx.timer.every(USAGE_MS, (/** @type {any} */ cx) => this.costs(cx));
    cx.spawn(async (/** @type {any} */ cx) => {
      for (;;) {
        const c = await nextCommand();
        try {
          this.command(cx, c);
        } catch (e) {
          console.error(`work.${c}: ${errorMessage(e)}`);
          recordFailure(`work.${c}`, "command", e);
        }
        this.wake(cx, "command");
      }
    });
  }

  get store() {
    return this.model.store;
  }

  get groups() {
    return this.model.groups;
  }

  // --- Keyboard ---------------------------------------------------------------

  // What the sidebar shows (WorkModel.view), with the selected row and step:
  // the one the keys moved to while the same space stays focused, else the
  // focused space's row, else the first. `live`: the pass's snapshot of
  // Herdr's live data (herdrSpaces), so a render reads it once.
  view(/** @type {any} */ live) {
    const now = Date.now();
    const active = live.active;
    return this.model.view(live, now, {
      by: this.groupBy(),
      folded: this.nav.folded,
      cap: C.workRepoRows ?? 0,
      expanded: this.nav.expanded,
      width: this.width,
      confirm: this.nav.confirming(now),
      armed: (/** @type {any} */ id) => this.nav.armed(id, now),
      picked: this.nav.picked(active),
    });
  }

  // How the rows are grouped: as last switched to, else as configured.
  /** @returns {string} */
  groupBy() {
    return this.by ?? C.workGroupBy ?? "repo";
  }

  // Switches between grouping by repo and by stage.
  toggleGroupBy(/** @type {any} */ cx) {
    this.by = this.groupBy() === "stage" ? "repo" : "stage";
    this.wake(cx, "group");
  }

  command(/** @type {any} */ cx, /** @type {any} */ c) {
    const live = herdrSpaces();
    const { rows, at, step, active } = this.view(live);
    const row = rows[at];
    if (["next", "prev", "step-next", "step-prev"].includes(c)) {
      const navRows = rows.map((/** @type {any} */ r) => ({
        path: r.key,
        steps: r.steps,
      }));
      this.nav.move(navRows, at, step, active, c);
    } else if (c === "step") {
      if (row?.steps[step]) this.step(cx, row.w, row.steps[step], true);
    } else if (c === "open") {
      if (row?.stacked) this.openStacked(row);
      else if (row) this.open(row.w);
    } else if (c === "open-pr") {
      if (row?.stacked) this.openStacked(row);
      else if (row) this.openPR(row.w);
    } else if (c === "open-ticket") {
      if (row) this.openTicket(cx, row.w);
    } else if (c === "group") this.toggleGroupBy(cx);
    else if (c === "refresh") this.refresh(cx, true);
    else if (c === "report") this.report(cx, rows, live);
    else if (c === "start") this.starts(cx);
    else console.error(`work: unknown command ${c}`);
  }

  // What the sidebar shows, as JSON in <app home>/work-report.json
  // (WorkModel.report), with how long renders take and the ticket URLs.
  // Everything but the ticket URLs is taken now, so a row's steps and its PR
  // always agree (a lookup may finish while the URLs are awaited).
  report(
    /** @type {any} */ cx,
    /** @type {any} */ rows0,
    /** @type {any} */ live,
  ) {
    const rows = rows0.filter((/** @type {any} */ r) => !r.stacked);
    const out = this.model.report(rows, live, Date.now(), {
      renders: this.renders.report(),
    });
    cx.spawn(async () => {
      const urls = await Promise.all(
        rows.map((/** @type {any} */ r) =>
          this.model.ticketUrl(r.w).catch(() => null),
        ),
      );
      for (const [i, row] of out.rows.entries()) row.ticketUrl = urls[i];
      const file = `${appHome()}/work-report.json`;
      await readTextFile(file)
        .then((old) =>
          writeTextFile(file, `${JSON.stringify(out, null, 2)}\n`, old),
        )
        .catch((e) => {
          console.error(`work.report: ${errorMessage(e)}`);
          recordFailure("work.report", "write report", e);
        });
    });
  }

  // Git only: worktrees and branches. Ticket and PR details follow separately,
  // so slow tracker/GitHub calls never hold up the next git refresh.
  // Renders follow what changed, not the 30 s poll.
  async scan(/** @type {any} */ cx, /** @type {any} */ force) {
    await configReady();
    const repos = await this.localRepos(force);
    const changed = await this.model.scan(repos);
    this.recheckWatched(cx);
    if (changed) this.wake(cx, "scan");
    this.details(cx, force);
  }

  // The local repos, found again when forced, when a watched space folder is
  // still unknown (it may be a new clone), or every REPOS_MS.
  localRepos(/** @type {any} */ force) {
    return this.repos.get(force || this.model.watching());
  }

  // The ticket and PR lookups that are due (WorkModel.lookups).
  async lookups(/** @type {any} */ cx, /** @type {any} */ force) {
    await this.model.lookups(force, {
      changed: () => this.wake(cx, "lookup"),
      tell: (w, was, pr) => this.tell(w, was, pr),
    });
  }

  // Render runs whenever spaces change. A local space whose folder isn't one of
  // our worktrees (nor a main checkout) may be a new worktree: refresh now
  // rather than at the next poll, and recheck a few times in case it appears
  // a little later.
  watchSpaces(/** @type {any} */ cx, /** @type {any} */ live) {
    this.model.settle(live, Date.now());
    // A worktree the scan just listed may get its space a moment later: look
    // again every WATCH_MS until it has one (or START_MS passes).
    if (this.model.waitingForSpaces(live, Date.now()) && !this.awaitTimer) {
      this.awaitTimer = true;
      cx.timer.after(WATCH_MS, (/** @type {any} */ cx) => {
        this.awaitTimer = false;
        this.wake(cx, "timer");
      });
    }
    if (!this.model.arrive(live, Date.now()).length) return;
    // Shows its steps once it's no longer starting, even if nothing changes.
    cx.timer.after(START_MS, (/** @type {any} */ cx) => this.wake(cx, "timer"));
    cx.timer.after(0, (/** @type {any} */ cx) => this.refresh(cx));
  }

  // After a scan: folders now listed are done; the rest get another try soon.
  recheckWatched(/** @type {any} */ cx) {
    this.model.recheck();
    if (this.model.watching() && !this.watchTimer) {
      this.watchTimer = true;
      cx.timer.after(WATCH_MS, (/** @type {any} */ cx) => {
        this.watchTimer = false;
        this.refresh(cx);
      });
    }
  }

  // A notification when something you'd wait for changes on a PR
  // (WorkModel.events).
  tell(/** @type {any} */ w, /** @type {any} */ was, /** @type {any} */ pr) {
    for (const n of this.model.events(w, was, pr, herdrSpaces())) notify(n);
  }

  // Presses a row's next step `step` for worktree `w` (WorkModel.step): one
  // asking for confirmation runs on its second click or key press (within a
  // few seconds). The View only draws the wait, runs timers and notifies.
  step(
    /** @type {any} */ cx,
    /** @type {any} */ w,
    /** @type {any} */ step,
    byKey = false,
  ) {
    const r = this.model.step(w, step, { byKey, now: Date.now() });
    if (r.outcome === "running") return;
    if (r.outcome === "confirm") {
      // Redraws once it expires.
      cx.timer.after(CONFIRM_MS, (/** @type {any} */ cx) =>
        this.wake(cx, "timer"),
      );
      return this.wake(cx, "step");
    }
    this.wake(cx, "step");
    cx.spawn(async (/** @type {any} */ cx) => {
      const { notices, fades } = await r.done;
      // The note fades after NOTE_MS: nothing else may re-render by then.
      if (fades)
        cx.timer.after(NOTE_MS + 50, (/** @type {any} */ cx) =>
          this.wake(cx, "timer"),
        );
      for (const n of notices) notify(n);
      this.wake(cx, "step");
      this.refresh(cx, true);
    });
  }

  open(/** @type {any} */ w) {
    const space = spaceOf(w, herdrSpaces());
    if (space) run("space.select", { id: space.id });
    // A hub's space is for terminals and git, so it starts without an agent.
    else if (w.hub) run("space.new", { name: w.repo.name, folder: w.path });
    else
      run("space.new", {
        name: w.handle?.label ?? w.branch.split("/").pop(),
        folder: w.path,
        argv: C.agent.argv,
      });
  }

  // Opens `w`'s PR in the browser; without one, says so.
  openPR(/** @type {any} */ w) {
    if (w.hub) return this.nothingToOpen(w);
    const url = this.model.prOf(w)?.url;
    if (url) return openUrl(url);
    notify({ title: `${this.who(w)}: no pull request`, level: "info" });
  }

  // Opens a stacked PR's sub-item (work-rows.js, stackItem) in the browser.
  openStacked(/** @type {any} */ item) {
    if (item.url) return openUrl(item.url);
    notify({
      title: `${this.who(item.w)}: no link for #${item.number}`,
      level: "info",
    });
  }

  // A hub has no ticket or PR.
  nothingToOpen(/** @type {any} */ w) {
    notify({
      title: `${w.repo.name} hub: nothing to open`,
      body: "The main checkout has no ticket or pull request.",
      level: "info",
    });
  }

  // Opens `w`'s ticket in the browser; for a branch that isn't one, says so.
  openTicket(/** @type {any} */ cx, /** @type {any} */ w) {
    if (w.hub) return this.nothingToOpen(w);
    cx.spawn(async () => {
      const url = await this.model.ticketUrl(w).catch(() => null);
      if (url) return openUrl(url);
      notify({
        title: `${this.who(w)}: ${this.model.isTicket(w) ? `no link for ${w.handle.label}` : "not a ticket"}`,
        level: "info",
      });
    });
  }

  who(/** @type {any} */ w) {
    return whoOf(w);
  }

  // cx.notify(), noting why for the render's timing (renders.js).
  wake(/** @type {any} */ cx, /** @type {any} */ why) {
    this.why ??= why;
    // A scan or lookup that changed what is known rebuilds the snapshot here,
    // in async code, so the render it asks for only reads it.
    this.store.warm();
    cx.notify();
  }

  // Draws the sidebar (draw); a render that throws (Herdr interrupts one that
  // runs too long) never reaches timed, so it's recorded here, with whether it
  // rebuilt the snapshot, before being passed on.
  render(/** @type {any} */ cx) {
    const start = Date.now();
    const trigger = this.why ?? "host";
    this.why = null;
    const rebuilds = this.store.rebuilds;
    try {
      return this.draw(cx, start, trigger);
    } catch (e) {
      recordFailure("work", "render interrupted", e, {
        elapsedMs: Date.now() - start,
        trigger,
        rebuilt: this.store.rebuilds !== rebuilds,
      }).catch(() => {});
      throw e;
    }
  }

  // What the sidebar's builders (work-rows.js) call on a click, hover or menu
  // choice: the View's state and effects behind each one, so the builders
  // themselves hold none. Read live when called (not when built).
  /** @returns {Record<string, (...args: any[]) => any>} */
  sidebarActions() {
    return {
      open: (w) => this.open(w),
      openStacked: (p) => this.openStacked(p),
      step: (cx, w, s) => this.step(cx, w, s),
      follow: (cx, w, id) =>
        id === "pr" ? this.openPR(w) : this.openTicket(cx, w),
      hoverRow: (cx, w, hovered) => {
        if (!hovered || this.hovered === w.path) return;
        this.hovered = w.path;
        this.wake(cx, "hover");
      },
      openLinks: (cx, w, open) => {
        if (open) this.linksOpen = w.path;
        else if (this.linksOpen === w.path) this.linksOpen = null;
        this.wake(cx, "menu");
      },
      closeLinks: (cx) => {
        this.linksOpen = null;
        this.wake(cx, "menu");
      },
      expand: (cx, key) => {
        this.nav.expand(key);
        cx.notify();
      },
      // Folds a group: its rows and their stacked PRs fold with it.
      fold: (cx, g) => {
        this.nav.fold(
          g.key,
          g.worktrees.flatMap((/** @type {any} */ r) => [
            r.key,
            ...r.stack.map((/** @type {any} */ p) => p.key),
          ]),
          g.hub ? g.hub.w.path : null,
        );
        this.wake(cx, "fold");
      },
      toggleGroupBy: (cx) => this.toggleGroupBy(cx),
      refresh: (cx) => this.refresh(cx, true),
      newWork: () => run("mod.open", { name: "tickets" }),
    };
  }

  // Draws the sidebar: the header, the problem (if any) and the list. The
  // elements come from work-rows.js (headerEl, bodyEl, messageEl); this keeps
  // the wiring: the live data, the theme, the View's actions, and the list's
  // hover and resize handlers.
  draw(
    /** @type {any} */ cx,
    /** @type {any} */ start,
    /** @type {any} */ trigger,
  ) {
    // One read of Herdr's live data for the whole render (herdrSpaces).
    const live = herdrSpaces();
    this.watchSpaces(cx, live);
    const t = theme();
    const view = this.view(live);
    const viewed = Date.now();
    const ui = {
      ...this.sidebarActions(),
      t,
      rail: view.span === "rail",
      hovered: this.hovered,
      linksOpen: this.linksOpen,
    };
    const refreshing = this.refresh.forcing() || this.details.forcing();
    const problem = C.problem
      ? messageEl(ui, "problem", C.problem, t.blocked)
      : null;

    const el = v_flex()
      .id("work")
      .size_full()
      .min_h(0)
      .on_size_change((/** @type {any} */ size, /** @type {any} */ cx) => {
        if (resize(this, size.width, fit)) this.wake(cx, "resize");
      })
      .child(headerEl(ui, view.by, refreshing))
      .when(Boolean(problem), (/** @type {any} */ el) => el.child(problem))
      .child(
        v_flex()
          .id("work-list")
          .flex_1()
          .min_h(0)
          .pb(6)
          .border_b_1()
          .border_color(t.border ?? t.dim)
          .overflow_y_scrollbar()
          .on_hover((/** @type {any} */ hovered, /** @type {any} */ cx) => {
            // Only entering a row renders: leaving the list is handled here.
            if (hovered || this.hovered === null) return;
            this.hovered = null;
            cx.notify();
          })
          .child(bodyEl(ui, view, this.groups === null)),
      );
    this.timed(start, viewed, view, trigger);
    return el;
  }

  // Records a render's timing (renders.js); a slow one as a failure too.
  timed(
    /** @type {any} */ start,
    /** @type {any} */ viewed,
    /** @type {any} */ view,
    /** @type {any} */ trigger,
  ) {
    const end = Date.now();
    const r = {
      ms: end - start,
      viewMs: viewed - start,
      buildMs: end - viewed,
      rows: view.rows.length,
      trigger,
      at: end,
    };
    if (this.renders.add(r))
      recordFailure("work", "slow render", `${r.ms} ms`, r);
  }
}
