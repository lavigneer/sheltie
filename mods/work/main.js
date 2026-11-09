// Work: a repo -> worktree outline for the Herdr sidebar.
//
// Every worktree of your local repos (open in a space or not), grouped by repo.
// Each group's header is also the repo's hub: its main checkout, with a space of its
// own for the repo's longer-running agents (no ticket, PR or steps). A repo
// shows while it has worktrees or its hub has a space.
// A row shows the ticket its branch names (key, summary, status), its pull
// request (review and checks) and the agent status of its space. Click a row to
// go to its space, or to open one there with the agent. Its ↗ button (shown on
// hover, on the selected row and while its menu is open) opens a menu: Open PR,
// Open ticket (in the browser), each only when the row has one. Its second
// line ends with what agents working in its folder have cost (usage.js).
// "+" opens the tickets popup to start new work; ↻ refreshes everything now.
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
// work.refresh refreshes everything now, like ↻. work.report writes what the
// sidebar shows to <app home>/work-report.json, for scripts and tests.
// work.start starts the tickets the requests in <app home>/work-start/ name,
// like the tickets popup (for agents and scripts; see drainRequests).
//
// State:
//   git refresh, details   each runs one at a time; a request during a run
//                          queues one more (serial(), watch.js), merging "force"
//   store                  repo state, plus caches (WorkStore, work.js) of tickets,
//                          tracker-linked PRs and PR details: { state: "found" |
//                          "none" | "failed", value, at }; "failed" (tracker/GitHub
//                          unreachable) is retried after a minute, never shown as "none"
//   steps                  per worktree: the last step run from here
//                          (running / done / failed, with a note)
//   confirming             the step waiting for its second click, if any
//   picked                 the row the keys moved to ({ path, step, active }),
//                          dropped when the focused space changes
//   watched                folders of spaces not yet listed as worktrees,
//                          rechecked a few times (the tickets popup makes the
//                          worktree first; an agent may make it later)
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
  spaces,
  theme,
  writeTextFile,
} from "herdr";
import { C, configReady } from "./config.js";
import {
  agentIn,
  agentSaysDone,
  nextSteps,
  prEvents,
  runStep,
} from "./flow.js";
import { hubExcept, localRepos, sameSlug } from "./git.js";
import { basename, cycle, openUrl, spaceFor } from "./lib.js";
import { resize } from "./sidebar.js";
import { drainRequests } from "./start.js";
import { ticketOfBranch } from "./tracker.js";
import { costIn, usageGroups } from "./usage.js";
import { serial } from "./watch.js";
import { prRef, WorkStore } from "./work.js";
import { fit, workView } from "./work-rows.js";

const GIT_MS = 30_000;
const DUE_CHECK_MS = 10_000; // how often to look for due lookups
const CONFIRM_MS = 4_000;
const USAGE_MS = 120_000; // agent costs (see usage.js)
const WATCH_MS = 3_000; // between rechecks of a new space's folder
const START_MS = 30_000; // how long a new space's agent may take to start working
const WATCH_TRIES = 3;
// Between finds of the local repos (and reads of their settings); the git
// scans in between reuse the last list. ↻ and new space folders find now.
const REPOS_MS = 300_000;
const LINKS_W = 18; // a row's ↗ button

// A row's space: a hub's leaves out its worktrees' folders (see spaceFor).
const spaceOf = (w) => spaceFor(w.path, w.except);

export default class Work extends View {
  init(_props, cx) {
    // null until the first scan; else every local repo:
    // [{ repo, hub: { path, branch, hub: true, except }, worktrees: [{ path, branch, key }] }]
    this.groups = null;
    this.mainCheckouts = new Set();
    // Repo state, tickets and PRs, and when each is due (work.js).
    this.store = new WorkStore();
    this.tickets = this.store.tickets; // by ticket key
    this.folded = new Set();
    this.watched = new Map(); // space folder -> tries
    // Folders of spaces that appeared while we run, and when: their agent is
    // starting until it first works (or START_MS passes), so it isn't offered
    // Draft PR before it has begun the ticket.
    this.starting = new Map();
    this.repos = null; // the last localRepos(), and when: { list, at }
    this.steps = new Map(); // worktree path -> { phase, text }
    // The step waiting for its second click: null | { id: `${path}:${step id}`,
    // byKey: whether a key press asked for it }.
    this.confirm = null;
    this.hovered = null; // the path of the row under the pointer
    this.linksOpen = null; // the path of the row whose ↗ menu is open
    this.picked = null; // { path, step, active }: see view()
    this.watchTimer = false;
    this.width = null; // ours, from on_size_change
    this.usage = null; // usage groups (usage.js), for each row's agent cost
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
      await drainRequests(`${appHome()}/work-start`).catch((e) =>
        console.error(`work.start: ${e?.message ?? e}`),
      );
      this.refresh(cx, true);
    });
    this.costs = serial(async (cx) => {
      await configReady();
      this.usage = await usageGroups().catch((e) => {
        console.error(`work: ${e?.message ?? e}`);
        return this.usage;
      });
      cx.notify();
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
        }
        cx.notify();
      }
    });
  }

  // --- Keyboard ---------------------------------------------------------------

  // The groups shown: repos with worktrees, or whose hub has a space.
  shownGroups() {
    return (this.groups ?? []).filter(
      (g) => g.worktrees.length || spaceOf(g.hub),
    );
  }

  // A row's next steps; none for a hub, or until its PR lookup has answered
  // (null then means "not known yet", not "no PR": guessing Draft PR would
  // flash a wrong, clickable button and shift the rows below when it goes).
  stepsOf(w, space) {
    if (w.hub) return [];
    const pr = this.prOf(w);
    const entry = this.store.prEntry(w.repo, w.branch);
    if (!pr && (!entry || entry.state === "failed")) return [];
    // A step just ran (Merge, Ready…): its PR is stale until looked up again,
    // and would offer that step once more.
    if (this.steps.get(w.path)?.staleAt) return [];
    const born = this.starting.get(w.path);
    if (space?.status === "working" || Date.now() - born >= START_MS)
      this.starting.delete(w.path);
    return nextSteps(pr, {
      working: space?.status === "working" || this.starting.has(w.path),
      agentDone: agentSaysDone(space),
      repo: w.repo,
    });
  }

  // What the sidebar shows (work-rows.js), with the selected row and step:
  // the one the keys moved to while the same space stays focused, else the
  // focused space's row, else the first. Adds active: the focused space's id.
  view() {
    const active = spaces().find((s) => s.active && !s.machine)?.id ?? null;
    if (this.picked && this.picked.active !== active) this.picked = null;
    const view = workView({
      groups: this.shownGroups(),
      folded: this.folded,
      width: this.width,
      steps: this.steps,
      confirm: this.confirm,
      picked: this.picked,
      now: Date.now(),
      spaceOf,
      stepsOf: (w, space) => this.stepsOf(w, space),
      prOf: (w) => this.prOf(w),
      ticketOf: (w) => this.tickets.get(w.handle.key),
      isTicket: (w) => this.isTicket(w),
      costOf: (w) => this.costOf(w),
    });
    return { ...view, active };
  }

  command(cx, c) {
    const { rows, at, step, active } = this.view();
    const row = rows[at];
    const pick = (i, s = 0) => {
      if (rows[i]) this.picked = { path: rows[i].w.path, step: s, active };
    };
    if (c === "next" || c === "prev") {
      if (rows.length) pick(cycle(rows.length, at, c === "next" ? 1 : -1));
    } else if (c === "step-next" || c === "step-prev") {
      if (row?.steps.length)
        pick(at, cycle(row.steps.length, step, c === "step-next" ? 1 : -1));
    } else if (c === "step") {
      if (row?.steps[step]) this.step(cx, row.w, row.steps[step], true);
    } else if (c === "open") {
      if (row) this.open(row.w);
    } else if (c === "open-pr") {
      if (row) this.openPR(row.w);
    } else if (c === "open-ticket") {
      if (row) this.openTicket(cx, row.w);
    } else if (c === "refresh") this.refresh(cx, true);
    else if (c === "report") this.report(cx, rows);
    else if (c === "start") this.starts(cx);
    else console.error(`work: unknown command ${c}`);
  }

  // What the sidebar shows, as JSON in <app home>/work-report.json: the shown
  // rows with their space's agent (where agent steps go) and whether it says
  // the PR is done (agentDone: its pr=ready label), PR, next steps and
  // last step, and which row and step the keys would act on, and what
  // work.open-pr / work.open-ticket would open (prUrl / ticketUrl).
  // Everything but the ticket URLs is taken now, so a row's steps and its PR
  // always agree (a lookup may finish while the URLs are awaited).
  report(cx, rows) {
    const out = this.reportNow(rows);
    cx.spawn(async () => {
      const urls = await Promise.all(
        rows.map((r) => this.ticketUrl(r.w).catch(() => null)),
      );
      for (const [i, row] of out.rows.entries()) row.ticketUrl = urls[i];
      const file = `${appHome()}/work-report.json`;
      await readTextFile(file)
        .then((old) =>
          writeTextFile(file, `${JSON.stringify(out, null, 2)}\n`, old),
        )
        .catch((e) => console.error(`work.report: ${e?.message ?? e}`));
    });
  }

  // The report of the view's rows (view()), without the ticket URLs (null
  // until report() adds them).
  reportNow(rows) {
    return {
      at: Date.now(),
      loaded: this.groups !== null,
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
          agent: agentIn(r.space),
          agentDone: agentSaysDone(r.space),
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

  // The last step run on a row (unfaded: a report keeps its note), or null.
  lastOf(w) {
    const last = this.steps.get(w.path);
    return last
      ? { phase: last.phase, text: last.text, at: last.at ?? null }
      : null;
  }

  // What the agents started in a row's folder have cost, in $, or null.
  costOf(w) {
    return this.usage ? costIn(this.usage, w.path) : null;
  }

  // Git only: worktrees and branches. Ticket and PR details follow separately,
  // so slow tracker/GitHub calls never hold up the next git refresh.
  async scan(cx, force) {
    await configReady();
    const repos = await this.localRepos(force);
    await this.store.scan(repos);
    this.mainCheckouts = new Set(repos.map((r) => r.path));
    this.groups = this.store.states.filter(Boolean).map((s) => ({
      repo: s.repo,
      hub: {
        path: s.repo.path,
        branch: s.mainBranch,
        hub: true,
        except: hubExcept(s.repo.path, s.linked),
      },
      worktrees: s.worktrees.map((w) => ({
        ...w,
        repo: s.repo,
        handle: ticketOfBranch(w.branch, s.repo),
      })),
    }));
    this.recheckWatched(cx);
    cx.notify();
    this.details(cx, force);
  }

  // A worktree's PR: the one from its branch, else one its ticket's tracker
  // links with that branch (joinWork); null for a hub or none known.
  prOf(w) {
    if (w.hub) return null;
    const own = this.store.prEntry(w.repo, w.branch)?.value;
    if (own || !w.handle) return own ?? null;
    return (
      this.store
        .snapshot([w.handle.key])
        .get(w.handle.key)
        ?.find((i) => i.worktree === w.path)?.pr ?? null
    );
  }

  // The local repos, found again when forced, when a watched space folder is
  // still unknown (it may be a new clone), or every REPOS_MS.
  async localRepos(force) {
    const pending = [...this.watched.values()].some((t) => t < WATCH_TRIES);
    if (
      force ||
      pending ||
      !this.repos ||
      Date.now() - this.repos.at >= REPOS_MS
    )
      this.repos = { list: await localRepos(), at: Date.now() };
    return this.repos.list;
  }

  // The ticket and PR lookups that are due (WorkStore.refresh).
  async lookups(cx, force) {
    if (!this.groups) return;
    const all = this.groups.flatMap((g) =>
      g.worktrees.map((w) => ({ ...w, repo: g.repo })),
    );
    // Each key once, with the tracker of the repo it's from.
    const keys = new Map(
      all.filter((w) => w.handle).map((w) => [w.handle.key, w.handle.tracker]),
    );
    await this.store.refresh(keys, {
      force,
      view: true,
      onTicket: () => cx.notify(),
      onPR: (ref, was, entry, asked) => {
        const pr = entry.value;
        for (const w of all) {
          const mine =
            (w.repo.slug && prRef(w.repo.slug, w.branch) === ref) ||
            (pr &&
              this.prOf(w)?.number === pr.number &&
              sameSlug(this.prOf(w)?.slug, pr.slug));
          if (!mine) continue;
          if (entry.state === "found" && was) this.tell(w, was, pr);
          const last = this.steps.get(w.path);
          if (last?.staleAt <= asked) delete last.staleAt;
        }
        cx.notify();
      },
    });
  }

  // Render runs whenever spaces change. A local space whose folder isn't one of
  // our worktrees (nor a main checkout) may be a new worktree: refresh now
  // rather than at the next poll, and recheck a few times in case it appears
  // a little later.
  watchSpaces(cx) {
    if (!this.groups) return;
    const known = this.knownFolders();
    const fresh = spaces()
      .filter((s) => !s.machine && s.folder)
      .map((s) => s.folder.replace(/\/+$/, ""))
      .filter((f) => !known.has(f) && !this.watched.has(f));
    if (!fresh.length) return;
    for (const f of fresh) {
      this.watched.set(f, 0);
      this.starting.set(f, Date.now());
    }
    // Shows its steps once it's no longer starting, even if nothing changes.
    cx.timer.after(START_MS, (cx) => cx.notify());
    cx.timer.after(0, (cx) => this.refresh(cx));
  }

  knownFolders() {
    return new Set([
      ...this.mainCheckouts,
      ...this.groups.flatMap((g) => g.worktrees.map((w) => w.path)),
    ]);
  }

  // After a scan: folders now listed are done; the rest get another try soon.
  recheckWatched(cx) {
    const known = this.knownFolders();
    let again = false;
    for (const [f, tries] of this.watched) {
      if (known.has(f)) this.watched.delete(f);
      else if (tries + 1 < WATCH_TRIES) {
        this.watched.set(f, tries + 1);
        again = true;
      } else this.watched.set(f, WATCH_TRIES); // given up: the 30 s poll covers it
    }
    if (again && !this.watchTimer) {
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
    const space = spaceOf(w);
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
    if (this.steps.get(path)?.phase === "running") return;
    const id = `${path}:${step.id}`;
    if (step.confirm && this.confirm?.id !== id) {
      // Only this request's timer ends it: an earlier one for the same step
      // (asked, run, then asked again) mustn't clear the new one.
      const mine = { id, byKey };
      this.confirm = mine;
      cx.timer.after(CONFIRM_MS, (cx) => {
        if (this.confirm === mine) this.confirm = null;
        cx.notify();
      });
      return cx.notify();
    }
    this.confirm = null;
    this.steps.set(path, { phase: "running", text: `${step.label}…` });
    cx.notify();
    const pr = this.prOf(w);
    // The ticket's work everywhere: worktrees and branches here, and the PRs
    // its tracker links (in repos with no worktree here too).
    const work = w.handle
      ? (this.store.snapshot([w.handle.key]).get(w.handle.key) ?? [])
      : [];
    cx.spawn(async (cx) => {
      const who = this.who(w);
      try {
        const note = await runStep(step.id, w, pr, work);
        const at = Date.now();
        this.steps.set(path, { phase: "done", text: note, at, staleAt: at });
        if (step.kind === "direct")
          notify({
            title: `${who}: ${step.label}`,
            body: note,
            level: "success",
          });
      } catch (e) {
        const text = `${e?.message ?? e}`.split("\n")[0];
        this.steps.set(path, { phase: "failed", text, at: Date.now() });
        notify({
          title: `${who}: ${step.label} failed`,
          body: text,
          level: "error",
        });
      }
      cx.notify();
      this.refresh(cx, true);
    });
  }

  open(w) {
    const space = spaceOf(w);
    if (space) run("space.select", { id: space.id });
    else
      run("space.new", {
        name: w.hub
          ? w.repo.name
          : (w.handle?.label ?? w.branch.split("/").pop()),
        folder: w.path,
        argv: C.agent.argv,
      });
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

  // Opens `w`'s PR in the browser; without one, says so.
  openPR(w) {
    if (w.hub) return this.nothingToOpen(w);
    const url = this.prOf(w)?.url;
    if (url) return openUrl(url);
    notify({ title: `${this.who(w)}: no pull request`, level: "info" });
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
      const url = await this.ticketUrl(w).catch(() => null);
      if (url) return openUrl(url);
      notify({
        title: `${this.who(w)}: ${this.isTicket(w) ? `no link for ${w.handle.label}` : "not a ticket"}`,
        level: "info",
      });
    });
  }

  who(w) {
    return w.handle?.label ?? basename(w.path);
  }

  render(cx) {
    this.watchSpaces(cx);
    const t = theme();
    const view = this.view();
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
            icon("refresh", "↻", "Refresh now", (cx) => this.refresh(cx, true)),
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

    // A step button: filled and accent-coloured, so it reads as clickable
    // next to plain labels; outlined only while picked or confirming.
    const button = (r, s) =>
      div()
        .id(`work-step-${r.w.path}-${s.id}`)
        .flex_none()
        .h(18)
        .px(6)
        .flex()
        .items_center()
        .rounded(5)
        .bg(t.hover)
        .border_1()
        .border_color(
          s.confirming ? t.blocked : s.chosen ? t.accent : "#00000000",
        )
        .text_size(11)
        .text_color(s.confirming ? t.blocked : t.accent)
        .cursor_pointer()
        .hover((st) => st.text_color(s.confirming ? t.blocked : t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.step(cx, r.w, s);
        })
        .child(s.text);

    // What a link in a row's ↗ menu does.
    const follow = (w, id, cx) =>
      id === "pr" ? this.openPR(w) : this.openTicket(cx, w);

    // A row's ↗: a menu of what it opens in the browser (the row's links).
    // It keeps its place while hidden, so showing it moves nothing.
    const linksMenu = (w, links) => {
      const close = (cx) => {
        this.linksOpen = null;
        cx.notify();
      };
      return Popover.new(`work-links-${w.path}`)
        .anchor("top_right")
        .open(this.linksOpen === w.path)
        .on_open_change((open, cx) => {
          if (open) this.linksOpen = w.path;
          else if (this.linksOpen === w.path) this.linksOpen = null;
          cx.notify();
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
          .on_hover((hovered, cx) => {
            if (hovered) this.hovered = w.path;
            else if (this.hovered === w.path) this.hovered = null;
            cx.notify();
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
                  .when(Boolean(pr) && pr.shown !== "full", (el) =>
                    el.child(
                      div()
                        .id(`work-pr-${w.path}`)
                        .flex_none()
                        .text_size(11)
                        .text_color(tone(pr.tone))
                        .tooltip(pr.text)
                        .child(pr.shown === "glyph" ? pr.glyph : pr.short),
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
    const group = (g) => {
      const { hub } = g;
      const fold = (cx) => {
        g.open ? this.folded.add(g.repo.path) : this.folded.delete(g.repo.path);
        cx.notify();
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
              .id(`work-repo-${g.repo.path}`)
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
          .child(dot(hub))
          .children(g.worktrees.map(dot));
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
        .children(g.worktrees.map(row));
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

    return v_flex()
      .id("work")
      .size_full()
      .min_h(0)
      .on_size_change((size, cx) => {
        if (resize(this, size.width, fit)) cx.notify();
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
          .child(body),
      );
  }
}
