// Tickets: Jira ticket -> git worktree -> coding agent, for the Herdr app.
//
// Lists your Jira tickets (JQL in config.js) with the work already linked to
// each: branches and worktrees whose name has the key, and pull requests that
// mention it, across your repos and GitHub owners. Enter on a ticket:
//   - nothing yet, and one obvious repo: create the worktree (BRANCH_PREFIX + key
//     under WORKTREE_DIR), open a space there and start the agent with the ticket;
//   - otherwise: choose from its work (open the space, or add a worktree for a
//     branch or PR), start it in a suggested repo (component / project maps, last
//     used, current repo) or any other repo, or ask the agent for another branch.
// Ad-hoc work, tied to no ticket: type what it is and choose "Start ad-hoc
// work" (the list's last row), then a repo: a worktree on a branch named after
// it (C.branch, {ref} a slug of the text) and the agent with it as its task
// (C.agent.adhocTask).
// Repos that aren't cloned yet are cloned into the first root with gh.
//
// Keys: type to filter, Up/Down or Ctrl+N/Ctrl+P to move, Enter to choose,
// Backspace (in an empty search) or the header's ‹ to go back, Esc to close,
// Ctrl+O to open the ticket in the browser, Ctrl+R to reload.
// Several at once: Tab marks tickets on the list; Enter then starts each
// marked ticket in its best suggested repo (as "Start in" would), one space
// each, once all their work is known.
// Opened with mod.open:tickets (prefix+t).
//
// State, each in one field and changed only through its setter (which redraws):
//   screen  list -> ticket -> pick; list -> adhoc (a repo for ad-hoc work)
//                                                                 go(); back() goes back one
//   data    tickets -> work -> ready | failed      load(); a reload supersedes
//           an older load, whose results are then dropped (gen)
//   action  idle -> running -> idle | failed       act(); while running, keys
//           and clicks are ignored. Esc is Herdr's: it always closes a popup,
//           which stops the action after its current step (every step leaves
//           a usable state: cloned, or cloned with its worktree), so choosing
//           it again carries on.
// A ticket's own screens wait for `ready`: until then its existing work is
// unknown, and starting could clash with a worktree that's already there.

import { h_flex, Input, InputState, v_flex } from "gpui-base";
import { div, svg, View } from "gpui-kit";
import { closeOverlay, focused, notify, props, run, theme } from "herdr";
import { C, configReady } from "./config.js";
import { prLabel, toneKey } from "./flow.js";
import {
  addWorktree,
  adhocBranch,
  cloneRepo,
  listWorktrees,
  localRepos,
  repoRoot,
  worktreePath,
} from "./git.js";
import { basename, fill, moveKey, openUrl, score, spaceFor } from "./lib.js";
import {
  errorText,
  learnClone,
  openSpaces,
  prepareStart,
  remember,
  rememberedRepo,
  repoId,
  spaceName,
  startTickets,
  taskValues,
} from "./start.js";
import { listTickets, suggestRepos, workFor } from "./work.js";

const repoLabel = (repo) => repo.slug || repo.name;

export default class Tickets extends View {
  init(_props, cx) {
    this.screen = { name: "list" }; // | { name: "ticket" | "pick", ticket } | { name: "adhoc", description }
    this.data = { phase: "tickets", gen: 0 };
    this.action = { phase: "idle" }; // | { phase: "running", message } | { phase: "failed", error }
    this.filter = "";
    this.at = 0;
    this.marked = new Set(); // ticket keys to start together (Tab)
    // One search box per kind of list, each with its own placeholder (an
    // InputState's is fixed); go() swaps them.
    this.inputs = {
      list: InputState.new({ placeholder: "Find a ticket…" }),
      ticket: InputState.new({ placeholder: "Filter actions…" }),
      pick: InputState.new({ placeholder: "Find a repo…" }),
    };
    this.inputs.adhoc = this.inputs.pick;
    for (const input of new Set(Object.values(this.inputs))) {
      input.on("change", (_e, cx) => {
        this.filter = input.value();
        this.at = 0;
        cx.notify();
      });
      input.on("submit", (_e, cx) =>
        this.screen.name === "list" && this.marked.size
          ? this.startMarked(cx)
          : this.choose(this.selected(), cx),
      );
    }
    this.input = this.inputs.list;
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    this.load(cx);
  }

  // --- State --------------------------------------------------------------

  go(screen, cx) {
    this.screen = screen;
    this.filter = "";
    this.input.set_value("");
    this.input = this.inputs[screen.name];
    this.input.set_value("");
    this.input.focus();
    this.at = 0;
    if (this.action.phase === "failed") this.action = { phase: "idle" };
    cx.notify();
  }

  back(cx) {
    if (this.screen.name === "list") return this.dismiss();
    this.go(
      this.screen.name === "pick"
        ? { name: "ticket", ticket: this.screen.ticket }
        : { name: "list" },
      cx,
    );
  }

  setData(data, cx) {
    this.data = data;
    cx.notify();
  }

  setAction(action, cx) {
    this.action = action;
    cx.notify();
  }

  get running() {
    return this.action.phase === "running";
  }

  // The ticket list first, then each ticket's work. A newer load (Ctrl+R)
  // supersedes this one: its results are dropped.
  load(cx) {
    const gen = this.data.gen + 1;
    const shown = this.data.tickets; // kept on screen if the reload fails
    this.setData({ phase: "tickets", gen }, cx);
    const cwd = focused()?.cwd ?? null;
    cx.spawn(async (cx) => {
      const current = () => this.data.gen === gen;
      let base = null;
      try {
        await configReady();
        const scan = localRepos();
        const [repos, here, tickets] = await Promise.all([
          scan,
          repoRoot(cwd),
          listTickets(scan),
        ]);
        if (!current()) return;
        base = { gen, tickets, repos, here };
        this.setData({ ...base, phase: "work", work: new Map() }, cx);
        // Local branches first, so a ticket's screen needn't wait for PRs;
        // then linked PRs, all a fresh ticket's auto-start waits for.
        const work = await workFor(tickets, repos, {
          onLocal: (work) => {
            if (!current()) return;
            base = { ...base, work, local: true };
            this.setData({ ...base, phase: "work" }, cx);
          },
          onLinked: (linked) => {
            if (!current()) return;
            base = { ...base, linked };
            this.setData({ ...base, phase: "work" }, cx);
          },
        });
        if (!current()) return;
        this.setData({ ...base, phase: "ready", work }, cx);
      } catch (e) {
        if (!current()) return;
        this.setData(
          {
            tickets: shown ?? [],
            repos: [],
            here: null,
            ...(base ?? {}),
            gen,
            phase: "failed",
            work: new Map(),
            error: errorText(e),
          },
          cx,
        );
      }
    });
  }

  // Runs an async action; keys are ignored meanwhile, and any error shown after.
  act(cx, message, f) {
    if (this.running) return;
    this.setAction({ phase: "running", message }, cx);
    cx.spawn(async (cx) => {
      try {
        await f(cx);
        this.setAction({ phase: "idle" }, cx);
      } catch (e) {
        this.setAction({ phase: "failed", error: errorText(e) }, cx);
      }
    });
  }

  // Not named close(): Herdr calls a View's close() itself when the overlay goes.
  dismiss() {
    closeOverlay(props().overlay);
  }

  // --- Rows ---------------------------------------------------------------
  //
  // Each row carries what it shows and what Enter or a click does (`run`), so
  // a label and its action can't disagree.

  rows() {
    const d = this.data;
    const keep = (rows, text) =>
      rows
        .map((r) => ({ r, s: score(text(r), this.filter) }))
        .filter((x) => x.s !== null)
        .sort((a, b) => a.s - b.s)
        .map((x) => x.r);
    if (this.screen.name === "list") {
      const rows = keep(
        (d.tickets ?? []).map((ticket) => ({
          kind: "ticket",
          ticket,
          work: d.work?.get(ticket.key) ?? [],
          run: (cx) => this.openTicket(ticket, cx),
        })),
        (r) => `${r.ticket.label} ${r.ticket.key} ${r.ticket.summary}`,
      );
      // Whatever was typed can start ad-hoc work; always last, never filtered.
      // Not before the list loads: Enter on a ticket's key typed early would
      // start ad-hoc work instead of the ticket.
      const description = this.filter.trim();
      if (d.tickets && adhocBranch(description))
        rows.push({
          kind: "action",
          label: `Start ad-hoc work: ${description}`,
          run: (cx) => this.go({ name: "adhoc", description }, cx),
        });
      return rows;
    }
    if (this.screen.name === "adhoc") {
      const { description } = this.screen;
      return keep(
        (d.repos ?? []).map((repo) => {
          const label = `Start in ${repoLabel(repo)}${repo.path ? "" : " (clone)"}`;
          const why = repo.path === d.here ? "current repo" : "";
          return {
            kind: "action",
            label,
            why,
            text: `${label} ${repo.name} ${why}`,
            run: (cx) =>
              this.act(cx, `Creating worktree in ${repoLabel(repo)}…`, (cx) =>
                this.startAdhoc(description, repo, cx),
              ),
          };
        }),
        (r) => r.text,
      );
    }
    // A ticket's screens need its local work at least: wait for it (see the
    // header). PRs, and work only a linked PR shows, fill in after.
    if (d.phase !== "ready" && !d.local) return [];
    const t = this.screen.ticket;
    if (this.screen.name === "pick") {
      return keep(
        d.repos.map((repo) =>
          this.startRow(t, repo, repo.path === d.here ? "current repo" : ""),
        ),
        (r) => r.text,
      );
    }
    const work = d.work.get(t.key) ?? [];
    const rows = work.map((item) => this.itemRow(t, item));
    const used = new Set(work.map((w) => repoId(w.repo)));
    for (const s of this.suggestions(t))
      if (!used.has(repoId(s.repo))) rows.push(this.startRow(t, s.repo, s.why));
    rows.push({
      kind: "action",
      label: "Start in another repo…",
      text: "start in another repo",
      run: (cx) => this.go({ name: "pick", ticket: t }, cx),
    });
    for (const repo of new Map(
      work.filter((w) => w.repo.path).map((w) => [w.repo.path, w.repo]),
    ).values()) {
      const label = `Ask ${basename(C.agent.argv[0])} for another branch in ${repoLabel(repo)}`;
      rows.push({
        kind: "action",
        label,
        text: label,
        run: () => this.another(t, repo),
      });
    }
    return keep(rows, (r) => r.text);
  }

  selected() {
    const rows = this.rows();
    return rows[Math.max(0, Math.min(this.at, rows.length - 1))];
  }

  suggestions(ticket) {
    return suggestRepos(
      ticket,
      this.data.repos,
      this.data.here,
      rememberedRepo(ticket.key),
    );
  }

  startRow(ticket, repo, why) {
    const label = `Start in ${repoLabel(repo)}${repo.path ? "" : " (clone)"}`;
    return {
      kind: "action",
      label,
      why,
      text: `${label} ${repo.name} ${why ?? ""}`,
      run: (cx) =>
        this.act(
          cx,
          `Creating worktree for ${ticket.label} in ${repoLabel(repo)}…`,
          (cx) => this.start(ticket, repo, cx),
        ),
    };
  }

  // What a piece of existing work shows (`tag`) and does, decided together.
  itemRow(ticket, item) {
    const name = spaceName(ticket, item.repo, this.data.work.get(ticket.key));
    let tag, run;
    if (item.worktree) {
      tag = spaceFor(item.worktree) ? "open" : "worktree";
      run = () => this.openSpace(name, item.worktree);
    } else if (item.branch) {
      tag = item.repo.path ? "branch" : "not cloned";
      run = (cx) =>
        this.act(cx, `Opening ${ticket.label}…`, async (cx) => {
          const repo = await this.local(item.repo, cx);
          const path = await addWorktree(repo, item.branch, {
            pr: item.pr?.number ?? null,
          });
          remember(ticket, repo);
          this.openSpace(name, path);
        });
    } else {
      // A PR whose branch we don't know: show it instead.
      tag = "PR";
      run = () => {
        if (item.pr?.url) openUrl(item.pr.url);
        this.dismiss();
      };
    }
    return {
      kind: "item",
      item,
      tag,
      text: `${repoLabel(item.repo)} ${item.branch ?? ""} ${item.pr ? `#${item.pr.number}` : ""}`,
      run,
    };
  }

  // --- Actions ------------------------------------------------------------

  choose(r, cx) {
    if (r && !this.running) r.run(cx);
  }

  openTicket(ticket, cx) {
    // A fresh ticket with one clear home: just start. Only once its work is
    // known: its local branches and the PRs its tracker links (not every PR's
    // details); before that, its screen waits (and says so).
    if (this.fresh(ticket)) {
      const s = this.suggestions(ticket);
      // The current repo is only a hint; a single mapped/remembered repo decides.
      const decided = s.filter((x) => x.why !== "current repo");
      if (decided.length === 1 && s[0] === decided[0] && s[0].repo.path)
        return this.act(cx, `Creating worktree for ${ticket.label}…`, (cx) =>
          this.start(ticket, s[0].repo, cx),
        );
    }
    this.go({ name: "ticket", ticket }, cx);
  }

  // No work on `ticket`, known for sure: once everything's in, or from its
  // local branches and linked PRs while PR details are still loading.
  fresh(ticket) {
    const d = this.data;
    if (d.work?.get(ticket.key)?.length) return false;
    if (d.phase === "ready") return true;
    return d.phase === "work" && d.local && d.linked
      ? !d.linked.get(ticket.key)?.length
      : false;
  }

  // The repo, cloned first if it isn't local yet.
  async local(repo, cx) {
    if (repo.path) return repo;
    this.setAction({ phase: "running", message: `Cloning ${repo.slug}…` }, cx);
    const cloned = await cloneRepo(repo.slug);
    learnClone(this.data.repos, repo, cloned);
    return cloned;
  }

  openSpace(name, folder, task) {
    this.openSpaces([{ name, folder, task }]);
  }

  openSpaces(spaces) {
    this.dismiss();
    openSpaces(spaces);
  }

  // New work on the ticket's own branch (C.branch) in `target`.
  async start(ticket, target, cx) {
    const s = await this.prepare(ticket, target, cx);
    this.openSpaces([s]);
  }

  // start()'s work up to opening the space: { name, folder, task }. Before
  // opening it, which closes this popup and with it any work still to do here.
  async prepare(ticket, target, cx) {
    return prepareStart(ticket, target, {
      work: this.data.work.get(ticket.key) ?? [],
      repos: this.data.repos,
      onStep: this.onStep(cx),
    });
  }

  onStep(cx) {
    return (message) => this.setAction({ phase: "running", message }, cx);
  }

  // Every marked ticket in its best suggested repo, then all their spaces at
  // once: opening one closes this popup, which would stop the rest.
  startMarked(cx) {
    if (this.running) return;
    const d = this.data;
    if (d.phase !== "ready")
      return this.setAction(
        { phase: "failed", error: "Still loading tickets' work, try again" },
        cx,
      );
    const tickets = d.tickets.filter((t) => this.marked.has(t.key));
    this.act(cx, `Creating ${tickets.length} worktrees…`, async (cx) => {
      const { results, spaces } = await startTickets(
        tickets.map((ticket) => ({ ticket, repo: null })),
        {
          repos: d.repos,
          work: d.work,
          here: d.here,
          onStep: this.onStep(cx),
        },
      );
      // Opening a space closes this popup: what didn't start is a notification.
      const left = results.filter((r) => r.status !== "started");
      if (left.length)
        notify({
          title: `${left.length} of ${results.length} tickets not started`,
          body: left.map((r) => `${r.label}: ${r.why}`).join("\n"),
          level: "warning",
        });
      this.marked.clear();
      this.openSpaces(spaces);
    });
  }

  // Ad-hoc work in `target`: its own branch (see adhocBranch), reused if it's
  // already there, and the agent told what it is.
  async startAdhoc(description, target, cx) {
    const repo = await this.local(target, cx);
    const branch = adhocBranch(description, repo);
    const path = worktreePath(repo, branch);
    const existing = (await listWorktrees(repo.path)).linked.some(
      (w) => w.path === path,
    );
    if (!existing) await addWorktree(repo, branch, { create: true });
    this.openSpace(
      basename(path),
      path,
      existing
        ? null
        : fill(C.agent.adhocTask, {
            description,
            branch,
            worktreeDir: C.worktreeDir,
          }),
    );
  }

  // The agent names and creates the extra branch itself (C.branch + a short description).
  another(ticket, repo) {
    this.dismiss();
    run("space.new", {
      name: `${ticket.label} ${repo.name}+`,
      folder: repo.path,
      argv: C.agent.argv,
      task: fill(C.agent.extraBranchTask, taskValues(ticket, { repo })),
    });
  }

  openInBrowser(ticket, cx) {
    cx.spawn(async () => {
      const url = await ticket.tracker.url(ticket.key).catch(() => null);
      if (url) await openUrl(url);
    });
  }

  // Returns true when the popup handled the key.
  onKey(e, rows, sel, cx) {
    if (this.running) return true; // nothing but the action until it finishes
    const ticket = this.screen.ticket ?? sel?.ticket;
    if (e.modifiers.control && e.key === "o" && ticket)
      this.openInBrowser(ticket, cx);
    else if (e.modifiers.control && e.key === "r") this.load(cx);
    else if (e.key === "tab" && this.screen.name === "list") {
      if (sel?.kind === "ticket") {
        const k = sel.ticket.key;
        if (!this.marked.delete(k)) this.marked.add(k);
        cx.notify();
      }
    } else if (
      e.key === "backspace" &&
      !this.filter &&
      this.screen.name !== "list"
    )
      this.back(cx);
    else if (moveKey(e, this, rows.length, () => {})) cx.notify();
    else return false;
    return true;
  }

  // The line under the search box: [text, isError], or null for none.
  status(rows) {
    const a = this.action;
    if (a.phase === "running") return [a.message, false];
    if (a.phase === "failed") return [a.error, true];
    const d = this.data;
    if (d.phase === "failed") return [`${d.error} (Ctrl+R to retry)`, true];
    const problem = C.problem ?? d.repos?.find((r) => r.problem)?.problem;
    if (problem && !this.screen.ticket) return [problem, true];
    if (d.phase === "tickets") return ["Loading tickets…", false];
    const onList = this.screen.name === "list";
    if (d.phase === "work")
      return [
        d.local
          ? "Looking for pull requests…"
          : onList
            ? "Looking for branches and pull requests…"
            : "Looking for this ticket's branches and pull requests…",
        false,
      ];
    if (onList && this.marked.size)
      return [
        `${this.marked.size} marked · Enter starts them, Tab unmarks`,
        false,
      ];
    if (!rows.length)
      return [
        !onList
          ? "Nothing matches"
          : d.tickets.length
            ? "No matching ticket"
            : "No tickets for this query",
        false,
      ];
    return null;
  }

  // --- Drawing ------------------------------------------------------------

  render() {
    const t = theme();
    const rows = this.rows();
    const sel = rows[Math.max(0, Math.min(this.at, rows.length - 1))];
    const tone = (label) => t[toneKey(label?.tone)];
    // Tags at a row's end: at most 150 px, and they shrink to an ellipsis
    // before the text they follow goes below its minimum.
    const small = (text, color = t.dim) =>
      div()
        .flex_shrink(1)
        .min_w(0)
        .max_w(150)
        .truncate()
        .text_size(11)
        .text_color(color)
        .child(text);
    // A PR's state and checks matter more than the title's tail: it keeps
    // its full width and the title gives way instead.
    const prTag = (pr) =>
      div().flex_none().text_size(11).text_color(tone(pr)).child(pr.text);
    const col = (w, text, color = t.dim) =>
      div()
        .w(w)
        .flex_none()
        .truncate()
        .text_size(11)
        .text_color(color)
        .child(text);
    const dot = (on) =>
      div()
        .w(12)
        .flex_none()
        .text_color(on ? t.accent : t.muted)
        .child(on ? "●" : "○");

    const line = (r, i, cells) =>
      h_flex()
        .id(`tk-${i}-${r.kind}`)
        .mx(4)
        .px(10)
        .h(32)
        .rounded(7)
        .gap(10)
        .items_center()
        .cursor_pointer()
        .when(r === sel, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.choose(r, cx))
        .children(cells.filter(Boolean));

    const row = (r, i) => {
      if (r.kind === "ticket") {
        const pr = r.work.map((w) => prLabel(w.pr)).find(Boolean);
        const where = [...new Set(r.work.map((w) => w.repo.name))];
        return line(r, i, [
          this.marked.has(r.ticket.key)
            ? div().w(12).flex_none().text_color(t.accent).child("✓")
            : dot(r.work.some((w) => w.worktree)),
          div()
            .w(100)
            .flex_none()
            .truncate()
            .font_semibold()
            .text_color(t.foreground)
            .child(r.ticket.label),
          div()
            .flex_1()
            .min_w(120)
            .truncate()
            .text_color(t.foreground)
            .child(r.ticket.summary),
          // Fixed-width columns, so they line up from row to row; a long
          // repo name is cut, never the PR's state.
          col(
            130,
            where.length > 2 ? `${where.length} repos` : where.join(", "),
          ),
          col(190, pr?.text ?? "", tone(pr)),
          col(90, r.ticket.status),
        ]);
      }
      if (r.kind === "item") {
        const pr = prLabel(r.item.pr);
        return line(r, i, [
          dot(Boolean(r.item.worktree)),
          // Sized to the name (up to half the row), so the branch, not the
          // repo, gives way first.
          div()
            .flex_none()
            .max_w_1_2()
            .truncate()
            .text_color(t.foreground)
            .child(repoLabel(r.item.repo)),
          div()
            .flex_1()
            .min_w(100)
            .truncate()
            .text_color(t.muted)
            .child(r.item.branch ?? r.item.pr?.title ?? ""),
          pr ? prTag(pr) : null,
          small(r.tag),
        ]);
      }
      return line(r, i, [
        div().w(12).flex_none().text_color(t.dim).child("+"),
        div()
          .flex_1()
          .min_w(100)
          .truncate()
          .text_color(t.foreground)
          .child(r.label),
        r.why ? small(r.why) : null,
      ]);
    };

    const title =
      this.screen.name === "list"
        ? "Tickets"
        : this.screen.name === "adhoc"
          ? `Ad-hoc: ${this.screen.description}`
          : `${this.screen.ticket.label}  ${this.screen.ticket.summary}`;
    // Esc mid-action closes the popup and stops after the current step (a
    // clone or fetch that has started finishes); doing it again carries on.
    const status = this.status(rows);
    // Status (loading, errors, marks) takes the hint's place in the header,
    // so it costs no extra row and the list never jumps.
    const hint = this.running
      ? `${status?.[0] ?? "Working…"} · Esc stops after this step`
      : status
        ? status[0]
        : this.screen.name === "list"
          ? "Tab mark · Ctrl+O browser · Ctrl+R reload · Esc"
          : "⌫ back · Esc";
    const onList = this.screen.name === "list";

    return v_flex()
      .id("tickets")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        if (this.onKey(e, rows, sel, cx)) cx.stop_propagation();
      })
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .when(!onList, (el) =>
            el.child(
              div()
                .id("tk-back")
                .px(6)
                .rounded(5)
                .flex_none()
                .text_size(15)
                .text_color(t.dim)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => {
                  if (!this.running) this.back(cx);
                })
                .tooltip("Back (⌫)")
                .child("‹"),
            ),
          )
          // A ticket's title may take two lines.
          .child(
            div()
              .flex_1()
              .min_w(120)
              .max_h(40)
              .overflow_hidden()
              .line_height(20)
              .text_size(15)
              .font_semibold()
              .text_color(t.foreground)
              .child(title),
          )
          .when(this.running, (el) =>
            el.child(
              svg("mods/workspace-chrome/spinner.svg")
                .size(11)
                .flex_none()
                .text_color(t.working)
                .spin(900),
            ),
          )
          .child(
            div()
              .flex_shrink(1)
              .min_w(0)
              .truncate()
              .text_size(11)
              .text_color(status?.[1] ? t.blocked : t.dim)
              .child(hint),
          ),
      )
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .rounded(9)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .child(
            svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim),
          )
          .child(
            Input.new(this.input)
              .flex_1()
              .h_full()
              .text_size(12.8)
              .text_color(t.foreground),
          ),
      )
      .when(rows.length > 0, (el) =>
        el.child(
          v_flex()
            .h(Math.min(420, 6 + rows.length * 32))
            .min_h(0)
            .flex_shrink(1)
            .pb(6)
            .overflow_y_scrollbar()
            .children(rows.map(row)),
        ),
      );
  }
}
