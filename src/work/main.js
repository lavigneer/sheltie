// Work: a repo -> worktree outline for the Herdr sidebar.
//
// Every worktree of your local repos (open in a space or not), grouped by repo.
// A row shows the ticket its branch names (key, summary, status), its pull
// request (review and checks) and the agent status of its space. Click a row to
// go to its space, or to open one there with the agent; click its PR label to
// open the PR in the browser, its ticket key or status to open the ticket.
// "+" opens the tickets popup to start new work; ↻ refreshes everything now.
//
// Under each row, buttons for its next step in the ticket workflow (Draft PR,
// Fix CI, Address comments, Ready, Merge, Finish; see flow.js). Finish and
// Clean up ask for a second click. Notifies you when CI finishes, review
// comments or a review arrive, or the PR merges.
//
// Keys (keys.json; delivered through nextCommand()): one row is selected,
// the focused space's by default. work.next / work.prev move the selection
// through the shown rows, work.step-next / work.step-prev pick one of its
// next steps (the first by default), work.step runs that step (Finish and
// Clean up: press twice) and work.open opens the row's space, like a click.
// work.open-pr / work.open-ticket open the row's PR / ticket in the browser,
// like clicking its PR label / its ticket key or status.
// work.refresh refreshes everything now, like ↻. work.report writes what the
// sidebar shows to <app home>/work-report.json, for scripts and tests.
//
// State:
//   git refresh, details   each runs one at a time; a request during a run
//                          queues one more (serial()), merging "force"
//   tickets, prs           caches of { state: "found" | "none" | "failed",
//                          value, at }; "failed" (tracker/GitHub unreachable) is
//                          retried after a minute and never shown as "none"
//   steps                  per worktree: the last step run from here
//                          (running / done / failed, with a note)
//   confirming             the step waiting for its second click, if any
//   picked                 the row the keys moved to ({ path, step, active }),
//                          dropped when the focused space changes
//   watched                folders of spaces not yet listed as worktrees,
//                          rechecked a few times (the tickets popup makes the
//                          worktree first; an agent may make it later)
// Git refreshes every 30 s and at once for a new space; PRs every 2 min (20 s
// while CI runs or a merge is pending), tickets every 10 min.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
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
import { basename, cycle, openUrl, pool, spaceFor } from "./lib.js";
import {
  keyOfBranch,
  localRepos,
  prDetails,
  prLabel,
  repoState,
  unresolvedThreads,
} from "./data.js";
import { agentIn, agentSaysDone, nextSteps, runStep } from "./flow.js";
import { tracker } from "./tracker.js";

const GIT_MS = 30_000;
const PR_MS = 120_000;
const ACTIVE_PR_MS = 20_000; // CI running, or waiting to merge
const DUE_CHECK_MS = 10_000; // how often to look for due lookups
const CONFIRM_MS = 4_000;
const NOTE_MS = 60_000; // how long a step's success note stays
const TICKET_MS = 600_000;
const RETRY_MS = 60_000; // after a failed tracker/GitHub lookup
const WATCH_MS = 3_000; // between rechecks of a new space's folder
const WATCH_TRIES = 3;
// Narrower than this, the sidebar draws a rail (as Herdr's own sidebar mods
// do): a status per row, its details on hover.
const RAIL = 160;

// Runs `body(cx, force)` one at a time. Asked again while running, it runs once
// more afterwards (forced if any of the requests was), rather than dropping it.
function serial(body) {
  let running = false;
  let queued = null; // null | { force }
  const start = (cx, force = false) => {
    if (running) {
      queued = { force: force || Boolean(queued?.force) };
      return;
    }
    running = true;
    cx.spawn(async (cx) => {
      try {
        await body(cx, force);
      } finally {
        running = false;
        const next = queued;
        queued = null;
        if (next) start(cx, next.force);
      }
    });
  };
  return start;
}

// A cache entry is due when missing, forced, failed a while ago, or old.
const due = (entry, force, maxAge, now) =>
  !entry ||
  force ||
  now - entry.at > (entry.state === "failed" ? RETRY_MS : maxAge);

// Looks something up into `cache[id]`: found / none (null) / failed. A failure
// keeps the last good value so a blip doesn't blank the row.
async function lookup(cache, id, f) {
  try {
    const value = await f();
    cache.set(id, { state: value ? "found" : "none", value, at: Date.now() });
  } catch {
    const last = cache.get(id);
    cache.set(id, {
      state: "failed",
      value: last?.value ?? null,
      at: Date.now(),
    });
  }
}

export default class Work extends View {
  init(_props, cx) {
    this.groups = null; // null until the first scan; [{ repo, worktrees: [{ path, branch, key }] }]
    this.mainCheckouts = new Set();
    this.tickets = new Map(); // key -> entry (see lookup)
    this.prs = new Map(); // worktree path -> entry
    this.folded = new Set();
    this.watched = new Map(); // space folder -> tries
    this.steps = new Map(); // worktree path -> { phase, text }
    this.confirming = null; // `${path}:${step id}`
    this.confirmByKey = false; // the confirmation was asked for by a key
    this.picked = null; // { path, step, active }: see selection()
    this.watchTimer = false;
    this.width = null; // ours, from on_size_change
    this.refresh = serial((cx, force) => this.scan(cx, force));
    this.details = serial((cx, force) => this.lookups(cx, force));
    this.refresh(cx);
    cx.timer.every(GIT_MS, (cx) => this.refresh(cx));
    // Ticket/PR lookups that are due, between git scans (only due ones run).
    cx.timer.every(DUE_CHECK_MS, (cx) => this.details(cx));
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

  // The rows shown (unfolded groups), in order, with their next steps.
  shownRows() {
    return (this.groups ?? [])
      .filter((g) => !this.folded.has(g.repo.path))
      .flatMap((g) => g.worktrees.map((w) => ({ ...w, repo: g.repo })))
      .map((w) => {
        const space = spaceFor(w.path);
        const steps =
          this.steps.get(w.path)?.phase === "running"
            ? []
            : nextSteps(this.prs.get(w.path)?.value ?? null, {
                working: space?.status === "working",
                agentDone: agentSaysDone(space),
              });
        return { w, space, steps };
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
      out.rows.forEach((row, i) => (row.ticketUrl = urls[i]));
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
        const pr = this.prs.get(r.w.path)?.value ?? null;
        const last = this.steps.get(r.w.path) ?? null;
        const confirming = this.confirming?.startsWith(`${r.w.path}:`)
          ? this.confirming.slice(r.w.path.length + 1)
          : null;
        return {
          path: r.w.path,
          branch: r.w.branch,
          key: r.w.key ?? null,
          repo: r.w.repo.slug ?? r.w.repo.name,
          space: r.space?.id ?? null,
          agent: agentIn(r.space),
          agentDone: agentSaysDone(r.space),
          selected: i === at,
          step: i === at ? step : null,
          steps: r.steps.map((s) => ({ id: s.id, label: s.label })),
          confirming,
          ticket: (r.w.key && this.tickets.get(r.w.key)?.value) || null,
          ticketUrl: null,
          prUrl: pr?.url ?? null,
          pr: pr && {
            number: pr.number,
            state: pr.state,
            draft: pr.draft,
            review: pr.review,
            checks: pr.checks,
            autoMerge: pr.autoMerge,
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

  // Git only: worktrees and branches. Ticket and PR details follow separately,
  // so slow tracker/GitHub calls never hold up the next git refresh.
  async scan(cx, force) {
    await configReady();
    const repos = (await localRepos()).filter((r) => r.path);
    const states = await pool(
      repos.map((repo) => async () => ({
        repo,
        ...(await repoState(repo)),
      })),
    );
    this.mainCheckouts = new Set(repos.map((r) => r.path));
    this.groups = states
      .filter((s) => s?.worktrees.length)
      .map((s) => ({
        repo: s.repo,
        worktrees: s.worktrees.map((w) => ({
          ...w,
          key: keyOfBranch(w.branch, s.repo),
        })),
      }));
    this.recheckWatched(cx);
    cx.notify();
    this.details(cx, force);
  }

  async lookups(cx, force) {
    if (!this.groups) return;
    const now = Date.now();
    const all = this.groups.flatMap((g) =>
      g.worktrees.map((w) => ({ ...w, repo: g.repo })),
    );
    const keys = [...new Set(all.map((w) => w.key).filter(Boolean))].filter(
      (k) => due(this.tickets.get(k), force, TICKET_MS, now),
    );
    const prs = all.filter((w) => {
      const entry = this.prs.get(w.path);
      const pr = entry?.value;
      const active =
        pr?.state === "OPEN" &&
        (pr.checks === "pending" || pr.autoMerge || pr.review === "APPROVED");
      return (
        w.repo.slug && due(entry, force, active ? ACTIVE_PR_MS : PR_MS, now)
      );
    });
    await Promise.all([
      pool(
        keys.map((key) => async () => {
          await lookup(this.tickets, key, () => tracker().view(key));
          cx.notify();
        }),
      ),
      pool(
        prs.map((w) => async () => {
          const before = this.prs.get(w.path)?.value;
          await lookup(this.prs, w.path, async () => {
            const pr = await prDetails(w.repo.slug, w.branch);
            if (pr?.state === "OPEN")
              pr.unresolved = await unresolvedThreads(
                w.repo.slug,
                pr.number,
              ).catch(() => before?.unresolved ?? null);
            return pr;
          });
          const entry = this.prs.get(w.path);
          if (entry.state === "found" && before)
            this.tell(w, before, entry.value);
          cx.notify();
        }),
      ),
    ]);
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
    for (const f of fresh) this.watched.set(f, 0);
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
    const space = spaceFor(w.path);
    const action = space
      ? { name: "space.select", args: { id: space.id } }
      : undefined;
    const say = (title, level, body) =>
      notify({ title: `${who}: ${title}`, body, level, action });
    if (was.checks === "pending" && pr.checks === "passed")
      say(
        "CI passed",
        "success",
        pr.draft ? "Ready to mark ready for review." : undefined,
      );
    if (was.checks === "pending" && pr.checks === "failed")
      say("CI failed", "error");
    if ((pr.unresolved ?? 0) > (was.unresolved ?? 0))
      say(
        `${pr.unresolved - (was.unresolved ?? 0)} new review comment${pr.unresolved - (was.unresolved ?? 0) === 1 ? "" : "s"}`,
        "warning",
      );
    if (was.review !== pr.review && pr.review === "APPROVED")
      say(
        "approved",
        "success",
        pr.autoMerge ? "Auto-merge will merge it." : undefined,
      );
    if (was.review !== pr.review && pr.review === "CHANGES_REQUESTED")
      say("changes requested", "warning");
    if (was.state !== "MERGED" && pr.state === "MERGED")
      say(
        "merged",
        "success",
        "Finish removes the worktree and resolves the ticket.",
      );
  }

  // Runs a next step for worktree `w`; one asking for confirmation runs on its
  // second click or key press (within a few seconds).
  step(cx, w, step, byKey = false) {
    const path = w.path;
    if (this.steps.get(path)?.phase === "running") return;
    const id = `${path}:${step.id}`;
    if (step.confirm && this.confirming !== id) {
      this.confirming = id;
      this.confirmByKey = byKey;
      cx.timer.after(CONFIRM_MS, (cx) => {
        if (this.confirming === id) this.confirming = null;
        cx.notify();
      });
      return cx.notify();
    }
    this.confirming = null;
    this.steps.set(path, { phase: "running", text: `${step.label}…` });
    cx.notify();
    const pr = this.prs.get(path)?.value ?? null;
    const others = this.groups
      .flatMap((g) => g.worktrees.map((o) => ({ ...o, repo: g.repo })))
      .filter((o) => o.path !== path)
      .map((o) => ({ w: o, pr: this.prs.get(o.path)?.value ?? null }));
    cx.spawn(async (cx) => {
      const who = this.who(w);
      try {
        const note = await runStep(step.id, w, pr, others);
        this.steps.set(path, { phase: "done", text: note, at: Date.now() });
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
    const space = spaceFor(w.path);
    if (space) run("space.select", { id: space.id });
    else
      run("space.new", {
        name: w.key ? tracker().labelOf(w.key) : w.branch.split("/").pop(),
        folder: w.path,
        argv: C.agent.argv,
      });
  }

  // Whether `w`'s branch names a ticket: only one the tracker says it doesn't
  // know (e.g. "UTF-8" in "fix-utf-8") isn't. Not looked up yet, or
  // unreachable: still a ticket.
  isTicket(w) {
    return Boolean(w.key) && this.tickets.get(w.key)?.state !== "none";
  }

  // Where `w`'s ticket is in the browser; null when its branch isn't a ticket.
  async ticketUrl(w) {
    return this.isTicket(w) ? await tracker().url(w.key) : null;
  }

  // Opens `w`'s PR in the browser; without one, says so.
  openPR(w) {
    const url = this.prs.get(w.path)?.value?.url;
    if (url) return openUrl(url);
    notify({ title: `${this.who(w)}: no pull request`, level: "info" });
  }

  // Opens `w`'s ticket in the browser; for a branch that isn't one, says so.
  openTicket(cx, w) {
    cx.spawn(async () => {
      const url = await this.ticketUrl(w).catch(() => null);
      if (url) return openUrl(url);
      notify({
        title: `${this.who(w)}: ${this.isTicket(w) ? `no link for ${tracker().labelOf(w.key)}` : "not a ticket"}`,
        level: "info",
      });
    });
  }

  who(w) {
    return w.key ? tracker().labelOf(w.key) : basename(w.path);
  }

  render(cx) {
    this.watchSpaces(cx);
    const t = theme();
    const rail = this.width !== null && this.width < RAIL;
    const icon = (name, label, onClick) =>
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
          .child(icon("new", "+", () => run("mod.open", { name: "tickets" })))
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
          .child(icon("refresh", "↻", (cx) => this.refresh(cx, true)))
          .child(icon("new", "+", () => run("mod.open", { name: "tickets" })));

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
      const confirming = this.confirming === `${w.path}:${s.id}`;
      const label = confirming
        ? `${s.label}? ${this.confirmByKey ? "press" : "click"} again`
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
        .text_size(10.5)
        .text_color(confirming ? t.blocked : t.foreground)
        .cursor_pointer()
        .hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.step(cx, w, s);
        })
        .child(div().min_w(0).truncate().child(label));
    };

    const sel = this.selection();
    const selected = sel.rows[sel.at]?.w.path ?? null;

    // What a row shows, for the full row and the rail.
    const look = (w) => {
      const space = spaceFor(w.path);
      const isSelected = w.path === selected;
      const entry = w.key ? this.tickets.get(w.key) : null;
      const ticket = entry?.value ?? null;
      const prValue = this.prs.get(w.path)?.value ?? null;
      const pr = prLabel(prValue);
      const extras = [
        prValue?.state === "OPEN" && prValue.autoMerge ? "auto-merge" : null,
      ].filter(Boolean);
      const steps = nextSteps(prValue, {
        working: space?.status === "working",
        agentDone: agentSaysDone(space),
      });
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
      // A label that opens something in the browser instead of the space.
      const link = (el, id, open) =>
        el
          .id(`work-${id}-${w.path}`)
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            open(cx);
          });
      const title = isTicket ? tracker().labelOf(w.key) : w.branch;
      const sub = ticket
        ? ticket.summary
        : isTicket
          ? entry?.state === "failed"
            ? `${w.branch} · ${tracker().name} unreachable`
            : w.branch
          : "";
      return {
        space,
        isSelected,
        ticket,
        pr,
        prColor,
        steps,
        last,
        note,
        title,
        sub,
        isTicket,
        link,
      };
    };

    // The rail (narrower than RAIL px): a row is its status, and a hover says
    // the rest. Clicks and keys work as in the full rows.
    const dot = (w) => {
      const { space, isSelected, pr, steps, last, title, sub } = look(w);
      const tip = [
        title,
        sub,
        pr?.text,
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
        ticket,
        pr,
        prColor,
        steps,
        last,
        note,
        title,
        sub,
        isTicket,
        link,
      } = look(w);
      return v_flex()
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
        .on_click(() => this.open(w))
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(status(space))
            .child(
              div()
                .flex_1()
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
                    .when(isTicket, (d) =>
                      link(d, "ticket", (cx) => this.openTicket(cx, w)),
                    )
                    .child(title),
                ),
            )
            .when(Boolean(pr), (el) =>
              el.child(
                link(
                  div()
                    .flex_shrink(1)
                    .min_w(0)
                    .truncate()
                    .text_size(10.5)
                    .text_color(prColor),
                  "pr",
                  () => this.openPR(w),
                ).child(pr.text),
              ),
            ),
        )
        .when(Boolean(sub || ticket?.status), (el) =>
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
                  link(
                    div()
                      .flex_shrink(1)
                      .min_w(0)
                      .truncate()
                      .text_size(10.5)
                      .text_color(t.dim),
                    "status",
                    (cx) => this.openTicket(cx, w),
                  ).child(ticket.status),
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
                    .text_size(10.5)
                    .text_color(note.color)
                    .child(note.text),
                ),
              ),
          ),
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
                    .text_size(10.5)
                    .text_color(t.dim)
                    .child(String(g.worktrees.length)),
                ),
            ),
        )
        .when(open, (el) =>
          el.children(
            g.worktrees.map((w) => (rail ? dot : row)({ ...w, repo: g.repo })),
          ),
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
            .text_size(12)
            .text_color(color)
            .tooltip(text)
            .child(id === "problem" ? "!" : "…")
        : div().px(14).py(4).text_size(11.5).text_color(color).child(text);
    const problem = C.problem ? message("problem", C.problem, t.blocked) : null;
    const body =
      this.groups === null
        ? message("loading", "Loading worktrees…", t.dim)
        : this.groups.length
          ? v_flex().gap(4).children(this.groups.map(group))
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
        v_flex().flex_1().min_h(0).pb(6).overflow_y_scrollbar().child(body),
      );
  }
}
