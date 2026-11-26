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
// State (groups, store, steps, starting folders and costs live in WorkModel,
// work-model.js, which tests reach without a View):
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
// Git refreshes every 30 s and at once for a new space; PRs every 2 min (20 s
// while CI runs or a merge is pending), tickets and their linked PRs every
// 10 min (the rules live in work.js).

import { h_flex, Popover, v_flex } from "gpui-base";
import { div, svg, View } from "gpui-kit";
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
import { prEvents, runStep, START_MS } from "./flow.js";
import { basename, openUrl } from "./lib.js";
import { CONFIRM_MS, Nav } from "./nav.js";
import { RepoCache } from "./polling.js";
import { RenderStats } from "./renders.js";
import { resize } from "./sidebar.js";
import { herdrSpaces } from "./spaces.js";
import { drainRequests } from "./start.js";
import { usageGroups } from "./usage.js";
import { serial } from "./watch.js";
import { spaceOf, WorkModel } from "./work-model.js";
import { fit, NOTE_MS } from "./work-rows.js";

const GIT_MS = 30_000;
const DUE_CHECK_MS = 10_000; // how often to look for due lookups
const USAGE_MS = 120_000; // agent costs (see usage.js)
const WATCH_MS = 3_000; // between rechecks of a new space's folder
const LINKS_W = 18; // a row's ↗ button

export default class Work extends View {
  init(_props, cx) {
    // Groups, steps, starting folders, costs and the store (work-model.js).
    this.model = new WorkModel();
    this.nav = new Nav(); // folds, picked row and step, confirm (nav.js)
    this.by = null; // "repo" | "stage"; null: C.workGroupBy (once loaded)
    this.repos = new RepoCache(); // the local repos (polling.js)
    this.hovered = null; // the path of the row under the pointer
    this.linksOpen = null; // the path of the row whose ↗ menu is open
    this.watchTimer = false;
    this.width = null; // ours, from on_size_change
    this.renders = new RenderStats(); // render timings, for work.report
    this.why = null; // what the next render is for (wake); null: Herdr's own
    this.refresh = serial((cx, force) => this.scan(cx, force));
    this.details = serial((cx, force) => this.lookups(cx, force));
    this.refresh(cx);
    cx.timer.every(GIT_MS, (cx) => this.refresh(cx));
    // Ticket/PR lookups that are due, between git scans (only due ones run).
    cx.timer.every(DUE_CHECK_MS, (cx) => this.details(cx));
    // work.start: every request waiting in <app home>/work-start (see
    // drainRequests, start.js), one run at a time.
    this.starts = serial(async (cx) => {
      await configReady();
      await drainRequests(`${appHome()}/work-start`).catch((e) => {
        console.error(`work.start: ${e?.message ?? e}`);
        recordFailure("work.start", "drain requests", e);
      });
      this.refresh(cx, true);
    });
    this.costs = serial(async (cx) => {
      await configReady();
      const usage = await usageGroups().catch((e) => {
        console.error(`work: ${e?.message ?? e}`);
        recordFailure("work", "usage", e);
        return this.model.usage;
      });
      // Rows show each folder's cost: re-render only when one moved.
      if (this.model.setUsage(usage)) this.wake(cx, "costs");
    });
    this.costs(cx);
    cx.timer.every(USAGE_MS, (cx) => this.costs(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        try {
          this.command(cx, c);
        } catch (e) {
          console.error(`work.${c}: ${e?.message ?? e}`);
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
  view(live) {
    const now = Date.now();
    const active = live.active;
    return this.model.view(live, now, {
      by: this.groupBy(),
      folded: this.nav.folded,
      cap: C.workRepoRows ?? 0,
      expanded: this.nav.expanded,
      width: this.width,
      confirm: this.nav.confirming(now),
      picked: this.nav.picked(active),
    });
  }

  // How the rows are grouped: as last switched to, else as configured.
  groupBy() {
    return this.by ?? C.workGroupBy ?? "repo";
  }

  // Switches between grouping by repo and by stage.
  toggleGroupBy(cx) {
    this.by = this.groupBy() === "stage" ? "repo" : "stage";
    this.wake(cx, "group");
  }

  command(cx, c) {
    const live = herdrSpaces();
    const { rows, at, step, active } = this.view(live);
    const row = rows[at];
    if (["next", "prev", "step-next", "step-prev"].includes(c)) {
      const navRows = rows.map((r) => ({ path: r.key, steps: r.steps }));
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
  report(cx, rows0, live) {
    const rows = rows0.filter((r) => !r.stacked);
    const out = this.model.report(rows, live, Date.now(), {
      renders: this.renders.report(),
    });
    cx.spawn(async () => {
      const urls = await Promise.all(
        rows.map((r) => this.model.ticketUrl(r.w).catch(() => null)),
      );
      for (const [i, row] of out.rows.entries()) row.ticketUrl = urls[i];
      const file = `${appHome()}/work-report.json`;
      await readTextFile(file)
        .then((old) =>
          writeTextFile(file, `${JSON.stringify(out, null, 2)}\n`, old),
        )
        .catch((e) => {
          console.error(`work.report: ${e?.message ?? e}`);
          recordFailure("work.report", "write report", e);
        });
    });
  }

  // Git only: worktrees and branches. Ticket and PR details follow separately,
  // so slow tracker/GitHub calls never hold up the next git refresh.
  // Renders follow what changed, not the 30 s poll.
  async scan(cx, force) {
    await configReady();
    const repos = await this.localRepos(force);
    const changed = await this.model.scan(repos);
    this.recheckWatched(cx);
    if (changed) this.wake(cx, "scan");
    this.details(cx, force);
  }

  // The local repos, found again when forced, when a watched space folder is
  // still unknown (it may be a new clone), or every REPOS_MS.
  localRepos(force) {
    return this.repos.get(force || this.model.watching());
  }

  // The ticket and PR lookups that are due (WorkModel.lookups).
  async lookups(cx, force) {
    await this.model.lookups(force, {
      changed: () => this.wake(cx, "lookup"),
      tell: (w, was, pr) => this.tell(w, was, pr),
    });
  }

  // Render runs whenever spaces change. A local space whose folder isn't one of
  // our worktrees (nor a main checkout) may be a new worktree: refresh now
  // rather than at the next poll, and recheck a few times in case it appears
  // a little later.
  watchSpaces(cx, live) {
    this.model.settle(live, Date.now());
    if (!this.model.arrive(live, Date.now()).length) return;
    // Shows its steps once it's no longer starting, even if nothing changes.
    cx.timer.after(START_MS, (cx) => this.wake(cx, "timer"));
    cx.timer.after(0, (cx) => this.refresh(cx));
  }

  // After a scan: folders now listed are done; the rest get another try soon.
  recheckWatched(cx) {
    this.model.recheck();
    if (this.model.watching() && !this.watchTimer) {
      this.watchTimer = true;
      cx.timer.after(WATCH_MS, (cx) => {
        this.watchTimer = false;
        this.refresh(cx);
      });
    }
  }

  // A notification when something you'd wait for changes on a PR.
  tell(w, was, pr) {
    const who = this.who(w);
    const space = spaceOf(w, herdrSpaces());
    const action = space
      ? { name: "space.select", args: { id: space.id } }
      : undefined;
    for (const { title, level, body } of prEvents(was, pr))
      notify({ title: `${who}: ${title}`, body, level, action });
  }

  // Runs a next step for worktree `w`; one asking for confirmation runs on its
  // second click or key press (within a few seconds).
  step(cx, w, step, byKey = false) {
    const path = w.path;
    const steps = this.model.steps;
    if (steps.get(path)?.phase === "running") return;
    const id = `${path}:${step.id}`;
    if (!this.nav.press(id, Boolean(step.confirm), byKey, Date.now())) {
      // Redraws once it expires.
      cx.timer.after(CONFIRM_MS, (cx) => this.wake(cx, "timer"));
      return this.wake(cx, "step");
    }
    steps.set(path, { phase: "running", text: `${step.label}…` });
    this.wake(cx, "step");
    const pr = this.model.prOf(w);
    // The ticket's work everywhere: worktrees and branches here, and the PRs
    // its tracker links (in repos with no worktree here too).
    const work = this.model.workOf(w);
    cx.spawn(async (cx) => {
      const who = this.who(w);
      try {
        const note = await runStep(step.id, w, pr, work);
        const at = Date.now();
        steps.set(path, { phase: "done", text: note, at, staleAt: at });
        // The note fades after NOTE_MS: nothing else may re-render by then.
        cx.timer.after(NOTE_MS + 50, (cx) => this.wake(cx, "timer"));
        if (step.kind === "direct")
          notify({
            title: `${who}: ${step.label}`,
            body: note,
            level: "success",
          });
      } catch (e) {
        const text = `${e?.message ?? e}`.split("\n")[0];
        steps.set(path, { phase: "failed", text, at: Date.now() });
        recordFailure("work", step.label, e, { path });
        notify({
          title: `${who}: ${step.label} failed`,
          body: text,
          level: "error",
        });
      }
      this.wake(cx, "step");
      this.refresh(cx, true);
    });
  }

  open(w) {
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
  openPR(w) {
    if (w.hub) return this.nothingToOpen(w);
    const url = this.model.prOf(w)?.url;
    if (url) return openUrl(url);
    notify({ title: `${this.who(w)}: no pull request`, level: "info" });
  }

  // Opens a stacked PR's sub-item (work-rows.js, stackItem) in the browser.
  openStacked(item) {
    if (item.url) return openUrl(item.url);
    notify({
      title: `${this.who(item.w)}: no link for #${item.number}`,
      level: "info",
    });
  }

  // A hub has no ticket or PR.
  nothingToOpen(w) {
    notify({
      title: `${w.repo.name} hub: nothing to open`,
      body: "The main checkout has no ticket or pull request.",
      level: "info",
    });
  }

  // Opens `w`'s ticket in the browser; for a branch that isn't one, says so.
  openTicket(cx, w) {
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

  who(w) {
    return w.handle?.label ?? basename(w.path);
  }

  // cx.notify(), noting why for the render's timing (renders.js).
  wake(cx, why) {
    this.why ??= why;
    // A scan or lookup that changed what is known rebuilds the snapshot here,
    // in async code, so the render it asks for only reads it.
    this.store.warm();
    cx.notify();
  }

  // Draws the sidebar (draw); a render that throws (Herdr interrupts one that
  // runs too long) never reaches timed, so it's recorded here, with whether it
  // rebuilt the snapshot, before being passed on.
  render(cx) {
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

  draw(cx, start, trigger) {
    // One read of Herdr's live data for the whole render (herdrSpaces).
    const live = herdrSpaces();
    this.watchSpaces(cx, live);
    const t = theme();
    const view = this.view(live);
    const viewed = Date.now();
    const rail = view.span === "rail";
    const tone = (name) => t[name] ?? t.accent;
    const icon = (name, label, tip, onClick) =>
      div()
        .id(`work-${name}`)
        .h(20)
        .px(5)
        .flex()
        .items_center()
        .rounded(5)
        .text_size(12.5)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(tip)
        .on_click((_e, cx) => {
          cx.stop_propagation();
          onClick(cx);
        })
        .child(label);
    // ↻ spins while a refresh asked for by hand (git, then tickets and PRs) runs.
    const refreshing = this.refresh.forcing() || this.details.forcing();
    const refreshLabel = refreshing
      ? svg("mods/workspace-chrome/spinner.svg").size(11).spin(900)
      : "↻";

    const header = rail
      ? h_flex()
          .h(30)
          .flex_none()
          .justify_center()
          .items_center()
          .child(
            icon("new", "+", "New work (tickets)", () =>
              run("mod.open", { name: "tickets" }),
            ),
          )
      : h_flex()
          .h(30)
          .flex_none()
          .px(12)
          .gap(4)
          .items_center()
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(11)
              .font_semibold()
              .text_color(t.dim)
              .child("Work"),
          )
          .child(
            icon(
              "group",
              "▤",
              view.by === "stage" ? "Group by repo" : "Group by stage",
              (cx) => this.toggleGroupBy(cx),
            ),
          )
          .child(
            icon(
              "refresh",
              refreshLabel,
              refreshing ? "Refreshing…" : "Refresh now",
              (cx) => this.refresh(cx, true),
            ),
          )
          .child(
            icon("new", "+", "New work (tickets)", () =>
              run("mod.open", { name: "tickets" }),
            ),
          );

    // A row's status glyph (or spinner), as work-rows.js decided it.
    const status = (r) => {
      const st = r.status;
      if (st.spin)
        return svg("mods/workspace-chrome/spinner.svg")
          .size(11)
          .flex_none()
          .text_color(tone(st.tone))
          .spin(900);
      const el = div().w(12).flex_none().text_color(tone(st.tone));
      return (
        st.tip ? el.id(`work-nospace-${r.w.path}`).tooltip(st.tip) : el
      ).child(st.glyph);
    };

    // A step button. The row's next step (primary) is the one solid thing in
    // the sidebar: accent fill, background-coloured text. Later steps are
    // quiet accent text. Picked: an accent outline; confirming: blocked.
    const button = (r, s) => {
      const solid = s.primary && !s.confirming;
      const ink = s.confirming ? t.blocked : solid ? t.background : t.accent;
      return div()
        .id(`work-step-${r.w.path}-${s.id}`)
        .flex_none()
        .h(18)
        .px(6)
        .flex()
        .items_center()
        .rounded(5)
        .bg(solid ? t.accent : s.confirming ? t.hover : "#00000000")
        .border_1()
        .border_color(
          s.confirming
            ? t.blocked
            : s.chosen
              ? solid
                ? t.foreground
                : t.accent
              : "#00000000",
        )
        .text_size(11)
        .when(solid, (el) => el.font_semibold())
        .text_color(ink)
        .cursor_pointer()
        .hover((st) =>
          solid ? st.bg(t.foreground) : st.bg(t.hover).text_color(ink),
        )
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.step(cx, r.w, s);
        })
        .child(s.text);
    };

    // What a link in a row's ↗ menu does.
    const follow = (w, id, cx) =>
      id === "pr" ? this.openPR(w) : this.openTicket(cx, w);

    // A row's ↗: a menu of what it opens in the browser (the row's links).
    // It keeps its place while hidden, so showing it moves nothing.
    const linksMenu = (w, links) => {
      const close = (cx) => {
        this.linksOpen = null;
        this.wake(cx, "menu");
      };
      return Popover.new(`work-links-${w.path}`)
        .anchor("top_right")
        .open(this.linksOpen === w.path)
        .on_open_change((open, cx) => {
          if (open) this.linksOpen = w.path;
          else if (this.linksOpen === w.path) this.linksOpen = null;
          this.wake(cx, "menu");
        })
        .trigger(
          div()
            .id(`work-links-button-${w.path}`)
            .w(LINKS_W)
            .h(18)
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(5)
            .text_size(11)
            .text_color(this.linksOpen === w.path ? t.foreground : t.dim)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Open in the browser")
            .on_click((_e, cx) => cx.stop_propagation())
            .child("↗"),
        )
        .content(
          v_flex()
            .p(4)
            .min_w(120)
            .rounded(7)
            .border_1()
            .border_color(t.border ?? t.dim)
            .bg(t.popover)
            .children(
              links.map((l) =>
                div()
                  .id(`work-open-${l.id}-${w.path}`)
                  .h(24)
                  .px(8)
                  .flex()
                  .items_center()
                  .rounded(5)
                  .text_size(12.5)
                  .text_color(t.foreground)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    close(cx);
                    follow(w, l.id, cx);
                  })
                  .child(l.label),
              ),
            ),
        );
    };

    // The rail: a row is its status, and a hover says the rest. Clicks and
    // keys work as in the full rows.
    const dot = (r) => {
      const { w, space, pr, num } = r;
      // With a space, the dot is the agent's: the PR's glyph goes by the
      // number.
      const prGlyph = Boolean(space && pr);
      return h_flex()
        .id(`work-${w.path}`)
        .mx(4)
        .min_h(24)
        .py(2)
        .justify_center()
        .items_center()
        .rounded(6)
        .border_l_2()
        .border_color(r.selected ? t.accent : "#00000000")
        .cursor_pointer()
        .when(Boolean(space?.active), (el) => el.bg(t.selected ?? t.hover))
        .hover((s) => s.bg(t.hover))
        .tooltip(r.tip)
        .on_click(() => this.open(w))
        .child(
          v_flex()
            .items_center()
            .child(status(r))
            .when(Boolean(num) || prGlyph, (el) =>
              el.child(
                h_flex()
                  .gap(2)
                  .text_size(9)
                  .when(Boolean(num), (e) =>
                    e.child(div().text_color(t.dim).child(num)),
                  )
                  .when(prGlyph, (e) =>
                    e.child(div().text_color(tone(pr.tone)).child(pr.glyph)),
                  ),
              ),
            ),
        );
    };

    const row = (r) => {
      const { w, space, pr, steps, note, links } = r;
      return (
        v_flex()
          .id(`work-${w.path}`)
          .mx(6)
          .px(8)
          .py(4)
          .gap(1)
          .rounded(7)
          .border_l_2()
          .border_color(r.selected ? t.accent : "#00000000")
          .cursor_pointer()
          .when(Boolean(space?.active), (el) => el.bg(t.selected ?? t.hover))
          .hover((s) => s.bg(t.hover))
          // Only entering a row renders: leaving one is followed by entering
          // the next, and leaving the list is handled on "work-list".
          .on_hover((hovered, cx) => {
            if (!hovered || this.hovered === w.path) return;
            this.hovered = w.path;
            this.wake(cx, "hover");
          })
          .on_click(() => this.open(w))
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(status(r))
              .child(
                div()
                  .flex_shrink(1)
                  .min_w(64)
                  .flex()
                  .child(
                    div()
                      .flex_shrink(1)
                      .min_w(0)
                      .truncate()
                      .text_size(12.5)
                      .text_color(t.foreground)
                      .when(Boolean(space?.active), (d) => d.font_semibold())
                      .child(r.title),
                  ),
              )
              // The rest of the line after the title (sized to its text): the
              // PR, at the right; it also pushes ↗ there.
              .child(
                h_flex()
                  .flex_1()
                  .min_w(0)
                  .justify_end()
                  // Narrow, the PR is a word, then a glyph (see prLabel),
                  // never cut.
                  .when(Boolean(pr) && pr.shown !== "full", (el) =>
                    el.child(
                      div()
                        .id(`work-pr-${w.path}`)
                        .flex_none()
                        .text_size(11)
                        .text_color(tone(pr.tone))
                        .tooltip(pr.text)
                        .child(pr.head),
                    ),
                  )
                  .when(Boolean(pr) && pr.shown === "full", (el) =>
                    el.child(
                      // The tail (the tone: checks, conflicts) stays whole;
                      // the rest of the PR truncates before it.
                      h_flex()
                        .min_w(0)
                        .gap(4)
                        .text_size(11)
                        .text_color(tone(pr.tone))
                        .child(div().min_w(0).truncate().child(pr.head))
                        .when(Boolean(pr.tail), (e) =>
                          e.child(div().flex_none().child(pr.tail)),
                        ),
                    ),
                  ),
              )
              .when(links.length > 0, (el) =>
                el.child(
                  r.selected ||
                    this.hovered === w.path ||
                    this.linksOpen === w.path
                    ? linksMenu(w, links)
                    : div().w(LINKS_W).flex_none(),
                ),
              ),
          )
          // Always there on a ticket's row, even while empty: its summary,
          // status and cost come from lookups that finish later, and the line
          // appearing then would push every row below it down. Any other
          // branch (its title already) is one line unless agents there cost.
          .when(
            Boolean(r.sub) || Boolean(w.handle) || Boolean(r.costText),
            (el) =>
              el.child(
                h_flex()
                  .pl(18)
                  .gap(6)
                  .child(
                    div()
                      .flex_1()
                      .min_w(48)
                      .truncate()
                      .text_size(11)
                      .text_color(t.dim)
                      .child(r.sub),
                  )
                  .when(Boolean(r.ticketStatus), (e) =>
                    e.child(
                      // Capped, so the summary keeps most of the line.
                      div()
                        .flex_shrink(1)
                        .min_w(0)
                        .max_w(88)
                        .truncate()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(r.ticketStatus),
                    ),
                  )
                  .when(Boolean(r.costText), (e) => e.child(costEl(r))),
              ),
          )
          .when(steps.length > 0 || Boolean(note), (el) =>
            el.child(
              h_flex()
                .flex_wrap()
                .pl(18)
                .pt(2)
                .gap_x(4)
                .gap_y(3)
                .items_center()
                .children(steps.map((s) => button(r, s)))
                .when(Boolean(note), (e) =>
                  e.child(
                    div()
                      .flex_1()
                      .min_w(60)
                      .truncate()
                      .text_size(11)
                      .text_color(tone(note.tone))
                      .child(note.text),
                  ),
                ),
            ),
          )
      );
    };

    // A stacked PR under its row (work-rows.js, stackItem): one indented
    // line, no steps; a click opens the PR. Merged or closed: dimmed. A tree
    // connector (├ / └ for the last) ties it to the row above.
    const subRow = (p, last) =>
      h_flex()
        .id(`work-${p.key}`)
        .mx(6)
        .pl(18)
        .pr(8)
        .h(20)
        .gap(6)
        .items_center()
        .rounded(6)
        .border_l_2()
        .border_color(p.selected ? t.accent : "#00000000")
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip(p.tip)
        .on_click(() => this.openStacked(p))
        .child(
          div()
            .flex_none()
            .text_size(11)
            .text_color(t.dim)
            .child(last ? "└" : "├"),
        )
        .child(
          div()
            .flex_none()
            .text_size(11)
            .text_color(tone(p.tone))
            .child(p.shown),
        )
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(11)
            .text_color(p.dim ? t.dim : t.muted)
            .child(p.title),
        );
    // On the rail: the PR's glyph, small, under its row's dot.
    const subDot = (p) =>
      div()
        .id(`work-${p.key}`)
        .mx(4)
        .h(16)
        .flex()
        .justify_center()
        .items_center()
        .rounded(6)
        .border_l_2()
        .border_color(p.selected ? t.accent : "#00000000")
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip(p.tip)
        .on_click(() => this.openStacked(p))
        .text_size(9)
        .text_color(tone(p.tone))
        .child(p.glyph);

    const costEl = (r) =>
      div()
        .id(`work-cost-${r.w.path}`)
        .flex_none()
        .text_size(11)
        .text_color(t.dim)
        .tooltip("What agents working here have cost (at API prices)")
        .child(r.costText);

    // A repo's header. In full, it is also its hub's row (the hub has no
    // ticket, PR or steps, so a row of its own would repeat in every group):
    // the chevron folds the group, the rest opens the hub like a row.
    // Below a capped repo group: "+k more" shows the rest, "Show fewer" goes
    // back to the cap (workRepoRows). On the rail, "+k".
    const moreRow = (g) => {
      const label = g.more
        ? rail
          ? `+${g.more}`
          : `+${g.more} more`
        : rail
          ? "−"
          : "Show fewer";
      return div()
        .id(`work-more-${g.key}`)
        .mx(rail ? 4 : 6)
        .px(rail ? 6 : 24)
        .h(20)
        .flex()
        .items_center()
        .when(rail, (el) => el.justify_center())
        .rounded(6)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .text_size(11)
        .text_color(t.dim)
        .tooltip(
          g.more
            ? `Show ${g.more} less recently changed worktree${g.more === 1 ? "" : "s"}`
            : "Show only the most recently changed",
        )
        .on_click((_e, cx) => {
          this.nav.expand(g.key);
          cx.notify();
        })
        .child(label);
    };
    const withMore = (el, g) => (g.more || g.fewer ? el.child(moreRow(g)) : el);

    const group = (g) => withMore(groupEl(g), g);
    const groupEl = (g) => {
      const { hub } = g;
      const fold = (cx) => {
        this.nav.fold(
          g.key,
          g.worktrees.flatMap((r) => [r.key, ...r.stack.map((p) => p.key)]),
          hub ? hub.w.path : null,
        );
        this.wake(cx, "fold");
      };
      const chevron = svg(
        `mods/workspace-chrome/chevron-${g.open ? "down" : "right"}.svg`,
      )
        .size(11)
        .flex_none()
        .text_color(t.dim);
      if (rail)
        return v_flex()
          .child(
            h_flex()
              .id(`work-repo-${g.key}`)
              .mx(4)
              .px(6)
              .h(24)
              .gap(5)
              .items_center()
              .justify_center()
              .tooltip(`${g.name} (${g.count})`)
              .rounded(6)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => fold(cx))
              .child(chevron)
              // A monogram tells repos apart without a hover.
              .child(
                div()
                  .text_size(11)
                  .font_semibold()
                  .text_color(t.muted)
                  .child(g.monogram),
              ),
          )
          .when(Boolean(hub), (el) => el.child(dot(hub)))
          .children(
            g.worktrees.flatMap((r) => [dot(r), ...r.stack.map(subDot)]),
          );
      // By stage: a plain header (no hub), the chevron and name fold it.
      if (!hub)
        return v_flex()
          .child(
            h_flex()
              .id(`work-group-${g.key}`)
              .mx(6)
              .px(6)
              .h(24)
              .gap(5)
              .items_center()
              .rounded(6)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => fold(cx))
              .child(chevron)
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(12.5)
                  .font_semibold()
                  .text_color(t.muted)
                  .child(g.name),
              )
              .child(
                div()
                  .id(`work-count-${g.key}`)
                  .flex_none()
                  .text_size(11)
                  .text_color(t.muted)
                  .tooltip(g.count)
                  .child(g.size),
              ),
          )
          .children(
            g.worktrees.flatMap((r) => [
              row(r),
              ...r.stack.map((p, i, all) => subRow(p, i === all.length - 1)),
            ]),
          );
      return v_flex()
        .child(
          h_flex()
            .id(`work-repo-${g.repo.path}`)
            .mx(6)
            .px(6)
            .h(24)
            .gap(5)
            .items_center()
            .rounded(6)
            .border_l_2()
            .border_color(hub.selected ? t.accent : "#00000000")
            .cursor_pointer()
            .when(Boolean(hub.space?.active), (el) =>
              el.bg(t.selected ?? t.hover),
            )
            .hover((s) => s.bg(t.hover))
            .tooltip(`${g.name} hub: ${hub.title}`)
            .on_click(() => this.open(hub.w))
            .child(
              div()
                .id(`work-fold-${g.repo.path}`)
                .flex_none()
                .rounded(4)
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  fold(cx);
                })
                .child(chevron),
            )
            .child(status(hub))
            .child(
              div()
                .flex_shrink(1)
                .min_w(0)
                .truncate()
                .text_size(12.5)
                .font_semibold()
                .text_color(t.muted)
                .child(g.name),
            )
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11)
                .text_color(t.dim)
                .child(hub.title),
            )
            .when(Boolean(hub.costText), (el) => el.child(costEl(hub)))
            .child(
              div()
                .id(`work-count-${g.repo.path}`)
                .flex_none()
                .text_size(11)
                // Neutral, like the repo name: the count carries no state.
                .text_color(t.muted)
                .tooltip(g.count)
                .child(g.size),
            ),
        )
        .children(
          g.worktrees.flatMap((r) => [
            row(r),
            ...r.stack.map((p, i, all) => subRow(p, i === all.length - 1)),
          ]),
        );
    };

    // Messages: in full on the rail too, on hover.
    const message = (id, text, color) =>
      rail
        ? div()
            .id(`work-${id}`)
            .py(4)
            .flex()
            .justify_center()
            .text_size(12.5)
            .text_color(color)
            .tooltip(text)
            .child(id === "problem" ? "!" : "…")
        : div().px(14).py(4).text_size(11).text_color(color).child(text);
    const problem = C.problem ? message("problem", C.problem, t.blocked) : null;
    const body =
      this.groups === null
        ? message("loading", "Loading worktrees…", t.dim)
        : view.groups.length
          ? v_flex().gap(4).children(view.groups.map(group))
          : message(
              "empty",
              "No worktrees yet. Press + to start a ticket.",
              t.dim,
            );

    const el = v_flex()
      .id("work")
      .size_full()
      .min_h(0)
      .on_size_change((size, cx) => {
        if (resize(this, size.width, fit)) this.wake(cx, "resize");
      })
      .child(header)
      .when(Boolean(problem), (el) => el.child(problem))
      .child(
        v_flex()
          .id("work-list")
          .flex_1()
          .min_h(0)
          .pb(6)
          .border_b_1()
          .border_color(t.border ?? t.dim)
          .overflow_y_scrollbar()
          .on_hover((hovered, cx) => {
            if (hovered || this.hovered === null) return;
            this.hovered = null;
            cx.notify();
          })
          .child(body),
      );
    this.timed(start, viewed, view, trigger);
    return el;
  }

  // Records a render's timing (renders.js); a slow one as a failure too.
  timed(start, viewed, view, trigger) {
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
