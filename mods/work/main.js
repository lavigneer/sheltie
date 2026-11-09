// Work: a repo -> worktree outline for the Herdr sidebar.
//
// Every worktree of your local repos (open in a space or not), grouped by repo.
// Each group starts with the repo's hub: its main checkout, with a space of its
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
  prLabel,
  runStep,
} from "./flow.js";
import { hubExcept, localRepos, sameSlug } from "./git.js";
import { basename, cycle, openUrl, spaceFor } from "./lib.js";
import { drainRequests } from "./start.js";
import { ticketOfBranch } from "./tracker.js";
import { costIn, dollars, usageGroups } from "./usage.js";
import { serial } from "./watch.js";
import { prRef, WorkStore } from "./work.js";

const GIT_MS = 30_000;
const DUE_CHECK_MS = 10_000; // how often to look for due lookups
const CONFIRM_MS = 4_000;
const NOTE_MS = 60_000; // how long a step's success note stays
const USAGE_MS = 120_000; // agent costs (see usage.js)
const WATCH_MS = 3_000; // between rechecks of a new space's folder
const START_MS = 30_000; // how long a new space's agent may take to start working
const WATCH_TRIES = 3;
// Between finds of the local repos (and reads of their settings); the git
// scans in between reuse the last list. ↻ and new space folders find now.
const REPOS_MS = 300_000;
// Narrower than this, the sidebar draws a rail (as Herdr's own sidebar mods
// do): a status per row, its details on hover.
const RAIL = 160;
const LINKS_W = 18; // a row's ↗ button

// A row's space: a hub's leaves out its worktrees' folders (see spaceFor).
const spaceOf = (w) => spaceFor(w.path, w.except);

// A group's rows: its hub, then its worktrees.
const rowsOf = (g) => [
  { ...g.hub, repo: g.repo },
  ...g.worktrees.map((w) => ({ ...w, repo: g.repo })),
];

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
    this.picked = null; // { path, step, active }: see selection()
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

  // The rows shown (unfolded groups), in order, with their next steps.
  shownRows() {
    return this.shownGroups()
      .filter((g) => !this.folded.has(g.repo.path))
      .flatMap(rowsOf)
      .map((w) => {
        const space = spaceOf(w);
        const steps =
          this.steps.get(w.path)?.phase === "running"
            ? []
            : this.stepsOf(w, space);
        return { w, space, steps };
      });
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

  // The selected row and step: the one the keys moved to while the same
  // space stays focused, else the focused space's row, else the first.
  // Returns { rows, at, step, active } (at: -1 without rows; active: the
  // focused space's id).
  selection() {
    const rows = this.shownRows();
    const active = spaces().find((s) => s.active && !s.machine)?.id ?? null;
    if (this.picked && this.picked.active !== active) this.picked = null;
    let at = this.picked
      ? rows.findIndex((r) => r.w.path === this.picked.path)
      : -1;
    let step = at >= 0 ? this.picked.step : 0;
    if (at < 0) {
      at = rows.findIndex((r) => r.space?.active);
      if (at < 0 && rows.length) at = 0;
      step = 0;
    }
    const n = rows[at]?.steps.length ?? 0;
    return { rows, at, step: n ? Math.min(step, n - 1) : 0, active };
  }

  command(cx, c) {
    const { rows, at, step, active } = this.selection();
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
    else if (c === "report") this.report(cx, rows, at, step);
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
  report(cx, rows, at, step) {
    const out = this.reportNow(rows, at, step);
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

  // The report, without the ticket URLs (null until report() adds them).
  reportNow(rows, at, step) {
    return {
      at: Date.now(),
      loaded: this.groups !== null,
      rows: rows.map((r, i) => {
        const pr = this.prOf(r.w);
        const last = this.steps.get(r.w.path) ?? null;
        const confirming = this.confirm?.id.startsWith(`${r.w.path}:`)
          ? this.confirm.id.slice(r.w.path.length + 1)
          : null;
        return {
          path: r.w.path,
          hub: Boolean(r.w.hub),
          branch: r.w.branch,
          key: r.w.handle?.key ?? null,
          repo: r.w.repo.slug ?? r.w.repo.name,
          space: r.space?.id ?? null,
          agent: agentIn(r.space),
          agentDone: agentSaysDone(r.space),
          cost: this.costOf(r.w),
          selected: i === at,
          step: i === at ? step : null,
          steps: r.steps.map((s) => ({
            id: s.id,
            label: s.label,
            confirm: Boolean(s.confirm),
          })),
          confirming,
          ticket:
            (r.w.handle && this.tickets.get(r.w.handle.key)?.value) || null,
          ticketUrl: null,
          prUrl: pr?.url ?? null,
          pr: pr && {
            number: pr.number,
            label: prLabel(pr)?.text ?? null,
            state: pr.state,
            draft: pr.draft,
            review: pr.review,
            checks: pr.checks,
            autoMerge: pr.autoMerge,
            mergeable: pr.mergeable,
            unresolved: pr.unresolved ?? null,
          },
          last: last && {
            phase: last.phase,
            text: last.text,
            at: last.at ?? null,
          },
        };
      }),
    };
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
    const rail = this.width !== null && this.width < RAIL;
    const icon = (name, label, tip, onClick) =>
      div()
        .id(`work-${name}`)
        .h(20)
        .px(5)
        .flex()
        .items_center()
        .rounded(5)
        .text_size(12)
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
              .child("WORK"),
          )
          .child(
            icon("refresh", "↻", "Refresh now", (cx) => this.refresh(cx, true)),
          )
          .child(
            icon("new", "+", "New work (tickets)", () =>
              run("mod.open", { name: "tickets" }),
            ),
          );

    const status = (space) => {
      if (!space) return div().w(12).flex_none().text_color(t.dim).child("○");
      if (space.status === "working")
        return svg("mods/workspace-chrome/spinner.svg")
          .size(11)
          .flex_none()
          .text_color(t.working)
          .spin(900);
      return div()
        .w(12)
        .flex_none()
        .text_color(t[space.status] ?? t.accent)
        .child("●");
    };

    // A step button keeps its label's width while it fits, and on its own
    // line (the steps wrap) narrower than that shrinks to an ellipsis.
    const button = (w, s, chosen) => {
      const confirming = this.confirm?.id === `${w.path}:${s.id}`;
      const label = confirming
        ? `${s.label}? ${this.confirm.byKey ? "Press" : "Click"} again`
        : s.label;
      return div()
        .id(`work-step-${w.path}-${s.id}`)
        .min_w(0)
        .h(18)
        .px(6)
        .flex()
        .items_center()
        .rounded(5)
        .border_1()
        .border_color(
          confirming ? t.blocked : chosen ? t.accent : (t.border ?? t.dim),
        )
        .text_size(11)
        .text_color(confirming ? t.blocked : t.foreground)
        .cursor_pointer()
        .hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.step(cx, w, s);
        })
        .child(div().min_w(0).truncate().child(label));
    };

    // A row's ↗: a menu of what it opens in the browser (see look()'s links).
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
                  .text_size(12)
                  .text_color(t.foreground)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    close(cx);
                    l.open(cx);
                  })
                  .child(l.label),
              ),
            ),
        );
    };

    const sel = this.selection();
    const selected = sel.rows[sel.at]?.w.path ?? null;

    // What a row shows, for the full row and the rail.
    const look = (w) => {
      const space = spaceOf(w);
      const isSelected = w.path === selected;
      const entry = w.handle ? this.tickets.get(w.handle.key) : null;
      const ticket = entry?.value ?? null;
      const prValue = this.prOf(w);
      const pr = prLabel(prValue);
      const extras = [
        prValue?.state === "OPEN" && prValue.autoMerge ? "auto-merge" : null,
      ].filter(Boolean);
      const steps = this.stepsOf(w, space);
      const step = this.steps.get(w.path);
      // A success note fades after a minute; a failure stays until the next step.
      const last =
        step?.phase === "done" && Date.now() - step.at > NOTE_MS ? null : step;
      // The row's third line: the last step's note, else these extras.
      const note = last
        ? {
            text: last.text,
            color: last.phase === "failed" ? t.blocked : t.dim,
          }
        : extras.length
          ? { text: extras.join(" · "), color: t.dim }
          : null;
      const prColor =
        pr?.tone === "bad" ? t.blocked : pr?.tone === "good" ? t.done : t.muted;
      // A branch that isn't a ticket (see isTicket) shows the branch.
      const isTicket = this.isTicket(w);
      // What the row's ↗ menu offers: only what applies.
      const links = w.hub
        ? []
        : [
            prValue?.url
              ? { id: "pr", label: "Open PR", open: () => this.openPR(w) }
              : null,
            isTicket
              ? {
                  id: "ticket",
                  label: "Open ticket",
                  open: (cx) => this.openTicket(cx, w),
                }
              : null,
          ].filter(Boolean);
      const title = w.hub
        ? (w.branch ?? "detached")
        : isTicket
          ? w.handle.label
          : w.branch;
      const sub = ticket
        ? ticket.summary
        : isTicket
          ? entry?.state === "failed"
            ? `${w.branch} · ${w.handle.tracker.name} unreachable`
            : w.branch
          : "";
      const cost = this.costOf(w);
      return {
        space,
        isSelected,
        cost: cost === null ? null : dollars(cost),
        ticket,
        pr,
        prColor,
        steps,
        last,
        note,
        title,
        sub,
        links,
      };
    };

    // The rail (narrower than RAIL px): a row is its status, and a hover says
    // the rest. Clicks and keys work as in the full rows.
    const dot = (w) => {
      const { space, isSelected, pr, cost, steps, last, title, sub } = look(w);
      const tip = [
        w.hub ? `${w.repo.name} hub: ${title}` : title,
        sub,
        pr?.text,
        cost && `agents ${cost}`,
        last?.phase === "running"
          ? last.text
          : steps.length
            ? `Next: ${steps.map((s) => s.label).join(", ")}`
            : null,
      ].filter(Boolean);
      return h_flex()
        .id(`work-${w.path}`)
        .mx(4)
        .h(24)
        .justify_center()
        .items_center()
        .rounded(6)
        .border_1()
        .border_color(isSelected ? t.accent : "#00000000")
        .cursor_pointer()
        .when(Boolean(space?.active), (el) => el.bg(t.selected ?? t.hover))
        .hover((s) => s.bg(t.hover))
        .tooltip(tip.join(" · "))
        .on_click(() => this.open(w))
        .child(status(space));
    };

    const row = (w) => {
      const {
        space,
        isSelected,
        cost,
        ticket,
        pr,
        prColor,
        steps,
        last,
        note,
        title,
        sub,
        links,
      } = look(w);
      return (
        v_flex()
          .id(`work-${w.path}`)
          .mx(6)
          .px(8)
          .py(4)
          .gap(1)
          .rounded(7)
          .border_1()
          .border_color(isSelected ? t.accent : "#00000000")
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
              .child(status(space))
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
                      .child(title),
                  ),
              )
              // The rest of the line after the title (sized to its text): the
              // PR, at the right; it also pushes the hub tag and ↗ there.
              .child(
                h_flex()
                  .flex_1()
                  .min_w(0)
                  .justify_end()
                  .when(Boolean(pr), (el) =>
                    el.child(
                      div()
                        .min_w(0)
                        .truncate()
                        .text_size(11)
                        .text_color(prColor)
                        .child(pr.text),
                    ),
                  ),
              )
              .when(Boolean(w.hub), (el) =>
                el.child(
                  div()
                    .flex_none()
                    .px(5)
                    .rounded(4)
                    .border_1()
                    .border_color(t.border ?? t.dim)
                    .text_size(11)
                    .text_color(t.dim)
                    .child("hub"),
                ),
              )
              .when(links.length > 0, (el) =>
                el.child(
                  isSelected ||
                    this.hovered === w.path ||
                    this.linksOpen === w.path
                    ? linksMenu(w, links)
                    : div().w(LINKS_W).flex_none(),
                ),
              ),
          )
          // Always there on a worktree row, even while empty: a ticket's
          // status and the cost come from lookups that finish later, and the
          // line appearing then would push every row below it down. A hub has
          // no ticket, so its row is one line unless agents there cost.
          .when(!w.hub || Boolean(cost), (el) =>
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
                    .child(sub),
                )
                .when(Boolean(ticket?.status), (e) =>
                  e.child(
                    // Capped, so the summary keeps most of the line.
                    div()
                      .flex_shrink(1)
                      .min_w(0)
                      .max_w(88)
                      .truncate()
                      .text_size(11)
                      .text_color(t.dim)
                      .child(ticket.status),
                  ),
                )
                .when(Boolean(cost), (e) =>
                  e.child(
                    div()
                      .id(`work-cost-${w.path}`)
                      .flex_none()
                      .text_size(11)
                      .text_color(t.dim)
                      .tooltip(
                        "What agents working here have cost (at API prices)",
                      )
                      .child(cost),
                  ),
                ),
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
                .children(
                  last?.phase === "running"
                    ? []
                    : steps.map((s, i) =>
                        button(w, s, isSelected && i === sel.step),
                      ),
                )
                .when(Boolean(note), (e) =>
                  e.child(
                    div()
                      .flex_1()
                      .min_w(60)
                      .truncate()
                      .text_size(11)
                      .text_color(note.color)
                      .child(note.text),
                  ),
                ),
            ),
          )
      );
    };

    const group = (g) => {
      const open = !this.folded.has(g.repo.path);
      return v_flex()
        .child(
          h_flex()
            .id(`work-repo-${g.repo.path}`)
            .mx(rail ? 4 : 6)
            .px(6)
            .h(24)
            .gap(5)
            .items_center()
            .when(rail, (el) =>
              el
                .justify_center()
                .tooltip(`${g.repo.name} (${g.worktrees.length})`),
            )
            .rounded(6)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => {
              open
                ? this.folded.add(g.repo.path)
                : this.folded.delete(g.repo.path);
              cx.notify();
            })
            .child(
              svg(
                `mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`,
              )
                .size(11)
                .flex_none()
                .text_color(t.dim),
            )
            .when(!rail, (el) =>
              el
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(12)
                    .font_semibold()
                    .text_color(t.muted)
                    .child(g.repo.name),
                )
                .child(
                  div()
                    .flex_none()
                    .text_size(11)
                    .text_color(t.dim)
                    .child(String(g.worktrees.length)),
                ),
            ),
        )
        .when(open, (el) => el.children(rowsOf(g).map(rail ? dot : row)));
    };

    // Messages: in full on the rail too, on hover.
    const message = (id, text, color) =>
      rail
        ? div()
            .id(`work-${id}`)
            .py(4)
            .flex()
            .justify_center()
            .text_size(12)
            .text_color(color)
            .tooltip(text)
            .child(id === "problem" ? "!" : "…")
        : div().px(14).py(4).text_size(11.5).text_color(color).child(text);
    const problem = C.problem ? message("problem", C.problem, t.blocked) : null;
    const shown = this.shownGroups();
    const body =
      this.groups === null
        ? message("loading", "Loading worktrees…", t.dim)
        : shown.length
          ? v_flex().gap(4).children(shown.map(group))
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
        const was = this.width !== null && this.width < RAIL;
        this.width = size.width;
        if (size.width < RAIL !== was) cx.notify();
      })
      .child(header)
      .when(Boolean(problem), (el) => el.child(problem))
      .child(
        v_flex()
          .id("work-list")
          .flex_1()
          .min_h(0)
          .pb(6)
          .overflow_y_scrollbar()
          .child(body),
      );
  }
}
