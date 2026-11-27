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
// State: the screen is this View's (go() and back()); the data, the action and
// the marked tickets are TicketsModel's (tickets-model.js), which the View reads
// through getters and changes through model calls (each redraws):
//   screen  list -> ticket -> pick; list -> adhoc (a repo for ad-hoc work);
//           the moves are declared in SCREENS. go() moves on, back() goes back one
//   data    tickets -> listed -> local -> linked -> ready | failed (tickets-model.js
//           says what each knows and the moves between them); load(); a reload
//           supersedes an older load, whose results are then dropped (gen)
//   action  idle -> running -> idle | failed       model.act(); while running, keys
//           and clicks are ignored. Esc is Herdr's: it always closes a popup,
//           which stops the action after its current step (every step leaves
//           a usable state: cloned, or cloned with its worktree), so choosing
//           it again carries on.
// A ticket's own screens wait for its local work (`local`): until then its
// existing work is unknown, and starting could clash with a worktree that's
// already there. Enter starts a fresh ticket without its screen only once
// `noWork` says it has none.

import { h_flex, Input, InputState, v_flex } from "gpui-base";
import { div, svg, View } from "gpui-kit";
import { closeOverlay, focused, props, run, theme } from "herdr";
import { C, configReady } from "./config.js";
import { prLabel, toneKey } from "./flow.js";
import { addWorktree, adhocBranch, localRepos, repoRoot } from "./git.js";
import { basename, columnWidth, fill, moveKey, openUrl, score } from "./lib.js";
import { herdrSpaces } from "./spaces.js";
import {
  openSpaces,
  remember,
  rememberedRepo,
  repoId,
  spaceName,
  taskValues,
} from "./start.js";
import {
  advance,
  localKnown,
  noWork,
  reloading,
  repoLabel,
  TicketsModel,
} from "./tickets-model.js";
import { listTickets, suggestRepos, workFor } from "./work.js";

// The popup's screens and every move between them. `to`: the screens a screen
// can move to, back included; `back`: where ⌫ and the header's ‹ go (none on
// the list: that closes the popup). go() throws on any other move, so a wrong
// one fails loudly instead of landing on a screen.
const SCREENS = {
  list: { to: ["ticket", "adhoc"] },
  ticket: { to: ["pick", "list"], back: "list" },
  pick: { to: ["ticket"], back: "ticket" },
  adhoc: { to: ["list"], back: "list" },
};

export default class Tickets extends View {
  /** @type {Record<string, any>} */
  inputs = /** @type {any} */ (undefined);
  /** @type {any} */
  input = /** @type {any} */ (undefined);
  /** @type {number} */
  at = /** @type {any} */ (undefined);
  /** @type {TicketsModel} */
  model = /** @type {any} */ (undefined);
  init(/** @type {any} */ _props, /** @type {any} */ cx) {
    this.screen = { name: "list" }; // | { name: "ticket" | "pick", ticket } | { name: "adhoc", description } (see SCREENS)
    this.filter = "";
    this.at = 0;
    // The data, the action and the marked tickets (tickets-model.js). Opening
    // spaces dismisses the popup first: it closes once they're to be opened.
    this.model = new TicketsModel({
      sources: { open: (/** @type {any} */ spaces) => this.openSpaces(spaces) },
    });
    // One search box per kind of list, each with its own placeholder (an
    // InputState's is fixed); go() swaps them.
    this.inputs = {
      list: InputState.new({ placeholder: "Find a ticket…" }),
      ticket: InputState.new({ placeholder: "Filter actions…" }),
      pick: InputState.new({ placeholder: "Find a repo…" }),
    };
    this.inputs.adhoc = this.inputs.pick;
    for (const input of new Set(Object.values(this.inputs))) {
      input.on("change", (/** @type {any} */ _e, /** @type {any} */ cx) => {
        this.filter = input.value();
        this.at = 0;
        cx.notify();
      });
      input.on("submit", (/** @type {any} */ _e, /** @type {any} */ cx) =>
        this.screen.name === "list" && this.model.marked.size
          ? this.task(cx, (/** @type {any} */ on) => this.model.startMarked(on))
          : this.choose(this.selected(), cx),
      );
    }
    this.input = this.inputs.list;
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    // Tab is bound by the window to "focus next", which wins over a plain
    // key_down handler and takes the keyboard off the search box. A binding
    // in the popup's own key context is deeper, so it wins instead.
    cx.bind_keys([
      { keystroke: "tab", action: "tickets::mark", context: "Tickets" },
    ]);
    this.load(cx);
  }

  // --- State --------------------------------------------------------------

  go(/** @type {any} */ screen, /** @type {any} */ cx) {
    if (
      !(
        /** @type {Record<string, any>} */ (SCREENS)[
          this.screen.name
        ].to.includes(screen.name)
      )
    )
      throw new Error(
        `Tickets: no move from ${this.screen.name} to ${screen.name}`,
      );
    this.screen = screen;
    this.filter = "";
    this.input.set_value("");
    this.input = this.inputs[screen.name];
    this.input.set_value("");
    this.input.focus();
    this.at = 0;
    this.model.clearFailure(this.notifying(cx));
    cx.notify();
  }

  back(/** @type {any} */ cx) {
    const back = /** @type {Record<string, any>} */ (SCREENS)[this.screen.name]
      .back;
    if (!back) return this.dismiss();
    // A ticket's screen keeps its ticket.
    this.go(
      back === "ticket"
        ? { name: back, ticket: this.screen.ticket }
        : { name: back },
      cx,
    );
  }

  // The model's data, and the action and marked tickets, read through these.
  get data() {
    return this.model.data;
  }

  get action() {
    return this.model.action;
  }

  get marked() {
    return this.model.marked;
  }

  get running() {
    return this.model.running;
  }

  // Where a task run from `cx` tells its changes: each one redraws.
  /** @param {any} cx */
  notifying(cx) {
    return { changed: () => cx.notify() };
  }

  // A model action, run as a spawned task from `cx` (a click or a key).
  /** @param {any} cx @param {(on: { changed: () => void }) => any} f */
  task(cx, f) {
    cx.spawn((/** @type {any} */ cx) => f(this.notifying(cx)));
  }

  /** @param {any} data @param {any} cx */
  setData(data, cx) {
    this.model.setData(data, this.notifying(cx));
  }

  // The ticket list first, then each ticket's work. A newer load (Ctrl+R)
  // supersedes this one: its results are dropped.
  load(/** @type {any} */ cx) {
    const gen = this.data.gen + 1;
    const shown = this.data.tickets; // kept on screen if the reload fails
    this.setData(reloading(gen), cx);
    const cwd = focused()?.cwd ?? null;
    cx.spawn(async (/** @type {any} */ cx) => {
      const current = () => this.data.gen === gen;
      // Moves to `phase` (tickets-model.js) unless a newer load has taken over.
      const to = (/** @type {any} */ phase, /** @type {any} */ fields) => {
        if (current()) this.setData(advance(this.data, phase, fields), cx);
      };
      try {
        await configReady();
        const scan = localRepos();
        const [repos, here, tickets] = await Promise.all([
          scan,
          repoRoot(cwd),
          listTickets(scan),
        ]);
        if (!current()) return;
        to("listed", { tickets, repos, here, work: new Map() });
        // Local branches first, so a ticket's screen needn't wait for PRs;
        // then linked PRs, all a fresh ticket's auto-start waits for.
        const work = await workFor(tickets, repos, {
          onLocal: (work) => to("local", { work }),
          onLinked: (linked) => to("linked", { linked }),
        });
        to("ready", { work });
      } catch (e) {
        if (!current()) return;
        this.model.failLoad(e, shown, this.notifying(cx));
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
    const keep = (/** @type {any} */ rows, /** @type {any} */ text) =>
      rows
        .map((/** @type {any} */ r) => ({ r, s: score(text(r), this.filter) }))
        .filter((/** @type {any} */ x) => x.s !== null)
        .sort((/** @type {any} */ a, /** @type {any} */ b) => a.s - b.s)
        .map((/** @type {any} */ x) => x.r);
    if (this.screen.name === "list") {
      const rows = keep(
        (d.tickets ?? []).map((/** @type {any} */ ticket) => ({
          kind: "ticket",
          ticket,
          work: d.work?.get(ticket.key) ?? [],
          run: (/** @type {any} */ cx) => this.openTicket(ticket, cx),
        })),
        (/** @type {any} */ r) =>
          `${r.ticket.label} ${r.ticket.key} ${r.ticket.summary}`,
      );
      // Whatever was typed can start ad-hoc work; always last, never filtered.
      // Not before the list loads: Enter on a ticket's key typed early would
      // start ad-hoc work instead of the ticket.
      const description = this.filter.trim();
      if (d.tickets && adhocBranch(description, null))
        rows.push({
          kind: "action",
          label: `Start ad-hoc work: ${description}`,
          run: (/** @type {any} */ cx) =>
            this.go({ name: "adhoc", description }, cx),
        });
      return rows;
    }
    if (this.screen.name === "adhoc") {
      const { description } = this.screen;
      return keep(
        (d.repos ?? []).map((/** @type {any} */ repo) => {
          const label = `Start in ${repoLabel(repo)}${repo.path ? "" : " (clone)"}`;
          const why = repo.path === d.here ? "current repo" : "";
          return {
            kind: "action",
            label,
            why,
            text: `${label} ${repo.name} ${why}`,
            run: (/** @type {any} */ cx) =>
              this.task(cx, (/** @type {any} */ on) =>
                this.model.startAdhoc(description, repo, on),
              ),
          };
        }),
        (/** @type {any} */ r) => r.text,
      );
    }
    // A ticket's screens need its local work at least: wait for it (see the
    // header). PRs, and work only a linked PR shows, fill in after.
    if (!localKnown(d)) return [];
    const t = this.screen.ticket;
    if (this.screen.name === "pick") {
      return keep(
        d.repos.map((/** @type {any} */ repo) =>
          this.startRow(t, repo, repo.path === d.here ? "current repo" : ""),
        ),
        (/** @type {any} */ r) => r.text,
      );
    }
    const work = d.work.get(t.key) ?? [];
    const live = herdrSpaces();
    const rows = work.map((/** @type {any} */ item) =>
      this.itemRow(t, item, live),
    );
    const used = new Set(work.map((/** @type {any} */ w) => repoId(w.repo)));
    for (const s of this.suggestions(t))
      if (!used.has(repoId(s.repo))) rows.push(this.startRow(t, s.repo, s.why));
    rows.push({
      kind: "action",
      label: "Start in another repo…",
      text: "start in another repo",
      run: (/** @type {any} */ cx) => this.go({ name: "pick", ticket: t }, cx),
    });
    for (const repo of new Map(
      work
        .filter((/** @type {any} */ w) => w.repo.path)
        .map((/** @type {any} */ w) => [w.repo.path, w.repo]),
    ).values()) {
      const label = `Ask ${basename(C.agent.argv[0])} for another branch in ${repoLabel(repo)}`;
      rows.push({
        kind: "action",
        label,
        text: label,
        run: () => this.another(t, repo),
      });
    }
    return keep(rows, (/** @type {any} */ r) => r.text);
  }

  selected() {
    const rows = this.rows();
    return rows[Math.max(0, Math.min(this.at, rows.length - 1))];
  }

  suggestions(/** @type {any} */ ticket) {
    return suggestRepos(
      ticket,
      this.data.repos,
      this.data.here,
      rememberedRepo(ticket.key),
    );
  }

  startRow(
    /** @type {any} */ ticket,
    /** @type {any} */ repo,
    /** @type {any} */ why,
  ) {
    const label = `Start in ${repoLabel(repo)}${repo.path ? "" : " (clone)"}`;
    return {
      kind: "action",
      label,
      why,
      text: `${label} ${repo.name} ${why ?? ""}`,
      run: (/** @type {any} */ cx) =>
        this.task(cx, (/** @type {any} */ on) =>
          this.model.start([ticket], repo, on),
        ),
    };
  }

  // What a piece of existing work shows (`tag`) and does, decided together.
  // `live`: the pass's snapshot (spaces.js).
  itemRow(
    /** @type {any} */ ticket,
    /** @type {any} */ item,
    /** @type {any} */ live,
  ) {
    const name = spaceName(ticket, item.repo, this.data.work.get(ticket.key));
    let tag, run;
    if (item.worktree) {
      tag = live.spaceOf(item.worktree) ? "open" : "worktree";
      run = () => this.openSpace(name, item.worktree);
    } else if (item.branch) {
      tag = item.repo.path ? "branch" : "not cloned";
      run = (/** @type {any} */ cx) =>
        this.task(cx, (/** @type {any} */ on) =>
          this.model.act(
            `Opening ${ticket.label}…`,
            async (/** @type {any} */ onStep) => {
              const repo = /** @type {any} */ (
                await this.model.local(item.repo, onStep)
              );
              const path = await addWorktree(repo, item.branch, {
                pr: item.pr?.number ?? null,
              });
              remember(ticket, repo);
              this.openSpace(name, path);
            },
            on,
          ),
        );
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

  choose(/** @type {any} */ r, /** @type {any} */ cx) {
    if (r && !this.running) r.run(cx);
  }

  openTicket(/** @type {any} */ ticket, /** @type {any} */ cx) {
    // A fresh ticket with one clear home: just start. Only once its work is
    // known (noWork): its local branches and the PRs its tracker links (not
    // every PR's details); before that, its screen waits (and says so).
    if (noWork(this.data, ticket.key)) {
      const s = this.suggestions(ticket);
      // The current repo is only a hint; a single mapped/remembered repo decides.
      const decided = s.filter((x) => x.why !== "current repo");
      if (decided.length === 1 && s[0] === decided[0] && s[0].repo.path)
        return this.task(cx, (/** @type {any} */ on) =>
          this.model.start([ticket], s[0].repo, on),
        );
    }
    this.go({ name: "ticket", ticket }, cx);
  }

  openSpace(
    /** @type {any} */ name,
    /** @type {any} */ folder,
    /** @type {any} */ task = undefined,
  ) {
    this.openSpaces([{ name, folder, task }]);
  }

  openSpaces(/** @type {any} */ spaces) {
    this.dismiss();
    openSpaces(spaces);
  }

  // The agent names and creates the extra branch itself (C.branch + a short description).
  another(/** @type {any} */ ticket, /** @type {any} */ repo) {
    this.dismiss();
    run("space.new", {
      name: `${ticket.label} ${repo.name}+`,
      folder: repo.path,
      argv: C.agent.argv,
      task: fill(C.agent.extraBranchTask, taskValues(ticket, { repo })),
    });
  }

  openInBrowser(/** @type {any} */ ticket, /** @type {any} */ cx) {
    cx.spawn(async () => {
      const url = await ticket.tracker.url(ticket.key).catch(() => null);
      if (url) await openUrl(url);
    });
  }

  // Returns true when the popup handled the key.
  onKey(
    /** @type {any} */ e,
    /** @type {any} */ rows,
    /** @type {any} */ sel,
    /** @type {any} */ cx,
  ) {
    if (this.running) return true; // nothing but the action until it finishes
    const ticket = this.screen.ticket ?? sel?.ticket;
    if (e.modifiers.control && e.key === "o" && ticket)
      this.openInBrowser(ticket, cx);
    else if (e.modifiers.control && e.key === "r") this.load(cx);
    else if (
      e.key === "backspace" &&
      !this.filter &&
      this.screen.name !== "list"
    )
      this.back(cx);
    else if (moveKey(e, this, rows.length, () => {})) cx.notify();
    else return false;
    return true;
  }

  // Tab on the list marks or unmarks the selected ticket.
  mark(/** @type {any} */ sel, /** @type {any} */ cx) {
    if (this.running || this.screen.name !== "list" || sel?.kind !== "ticket")
      return;
    this.model.mark(sel.ticket, this.notifying(cx));
    this.input.focus();
  }

  // The line under the search box: [text, isError], or null for none.
  status(/** @type {any} */ rows) {
    const a = this.action;
    if (a.phase === "running") return [a.message, false];
    if (a.phase === "failed") return [a.error, true];
    const d = this.data;
    if (d.phase === "failed")
      return rows.length ? [`${d.error} (Ctrl+R to retry)`, true] : null; // shown in the list's place instead (empty)
    const problem =
      C.problem ?? d.repos?.find((/** @type {any} */ r) => r.problem)?.problem;
    if (problem && !this.screen.ticket) return [problem, true];
    if (d.phase === "tickets") return ["Loading tickets…", false];
    const onList = this.screen.name === "list";
    if (d.phase === "listed")
      return [
        onList
          ? "Looking for branches and pull requests…"
          : "Looking for this ticket's branches and pull requests…",
        false,
      ];
    if (d.phase === "local" || d.phase === "linked")
      return ["Looking for pull requests…", false];
    if (onList && this.marked.size)
      return [
        `${this.marked.size} marked · Enter starts them, Tab unmarks`,
        false,
      ];
    return null;
  }

  // What the list's place shows when it has no rows, or null: [text, isError].
  // In the body, not the header's small hint, so it can't be missed.
  empty(/** @type {any} */ rows) {
    const d = this.data;
    if (rows.length || this.running) return null;
    if (d.phase === "failed") return [`${d.error} · Ctrl+R to retry`, true];
    if (d.phase === "tickets" || d.phase === "listed") return null;
    const onList = this.screen.name === "list";
    if (!onList) return ["Nothing matches", false];
    if (d.tickets.length) return ["No matching ticket", false];
    return ["No tickets for this query · type to start ad-hoc work", false];
  }

  // --- Drawing ------------------------------------------------------------

  render() {
    const t = theme();
    const rows = this.rows();
    const sel = rows[Math.max(0, Math.min(this.at, rows.length - 1))];
    const tone = (/** @type {any} */ label) => t[toneKey(label?.tone)];
    // Tags at a row's end: at most 150 px, and they shrink to an ellipsis
    // before the text they follow goes below its minimum.
    const small = (/** @type {any} */ text, color = t.dim) =>
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
    const prTag = (/** @type {any} */ pr) =>
      div().flex_none().text_size(11).text_color(tone(pr)).child(pr.text);
    const col = (
      /** @type {any} */ w,
      /** @type {any} */ text,
      color = t.dim,
    ) =>
      div()
        .w(w)
        .flex_none()
        .truncate()
        .text_size(11)
        .text_color(color)
        .child(text);
    const dot = (/** @type {any} */ on) =>
      div()
        .w(12)
        .flex_none()
        .text_color(on ? t.accent : t.muted)
        .child(on ? "●" : "○");

    const line = (
      /** @type {any} */ r,
      /** @type {any} */ i,
      /** @type {any} */ cells,
    ) =>
      h_flex()
        .id(`tk-${i}-${r.kind}`)
        .mx(4)
        .px(10)
        .h(32)
        .rounded(7)
        .gap(10)
        .items_center()
        .cursor_pointer()
        // As in the Work sidebar: the keyboard's row has an accent edge, so
        // it reads apart from the mouse's (hover); a marked ticket is tinted.
        .border_l_2()
        .border_color(r === sel ? t.accent : "#00000000")
        .when(
          r.kind === "ticket" && this.marked.has(r.ticket.key),
          (/** @type {any} */ el) => el.bg(t.selected ?? t.hover),
        )
        .hover((/** @type {any} */ s) => s.bg(t.hover))
        .on_click((/** @type {any} */ _e, /** @type {any} */ cx) =>
          this.choose(r, cx),
        )
        .children(cells.filter(Boolean));

    // A ticket row's cells besides its summary. The columns are as wide as
    // their widest entry among the rows shown (the same in every row, so they
    // line up), and one with nothing in it is left out: the summary gets the
    // rest of the row instead of space held for empty columns.
    const ticketCells = (/** @type {any} */ r) => {
      const where = [
        ...new Set(r.work.map((/** @type {any} */ w) => w.repo.name)),
      ];
      return {
        pr: r.work.map((/** @type {any} */ w) => prLabel(w.pr)).find(Boolean),
        repos: where.length > 2 ? `${where.length} repos` : where.join(", "),
      };
    };
    const tickets = rows.filter((/** @type {any} */ r) => r.kind === "ticket");
    const cells = new Map(
      tickets.map((/** @type {any} */ r) => [r, ticketCells(r)]),
    );
    const all = [...cells.values()];
    const widths = {
      label: columnWidth(
        tickets.map((/** @type {any} */ r) => r.ticket.label),
        8,
        100,
      ),
      repos: columnWidth(
        all.map((c) => c.repos),
        6.5,
        130,
      ),
      pr: columnWidth(
        all.map((c) => c.pr?.text),
        6.5,
        190,
      ),
      status: columnWidth(
        tickets.map((/** @type {any} */ r) => r.ticket.status),
        6.5,
        90,
      ),
    };
    const ticketCol = (
      /** @type {any} */ w,
      /** @type {any} */ text,
      /** @type {any} */ color,
    ) => (w ? col(w, text, color) : null);

    const row = (/** @type {any} */ r, /** @type {any} */ i) => {
      if (r.kind === "ticket") {
        const { pr, repos } = cells.get(r);
        return line(r, i, [
          this.marked.has(r.ticket.key)
            ? div().w(12).flex_none().text_color(t.accent).child("✓")
            : dot(r.work.some((/** @type {any} */ w) => w.worktree)),
          widths.label
            ? div()
                .w(widths.label)
                .flex_none()
                .truncate()
                // The summary is what a ticket is picked by; the key is
                // secondary, as in the Work sidebar.
                .text_color(t.dim)
                .child(r.ticket.label)
            : null,
          div()
            .flex_1()
            .min_w(120)
            .truncate()
            .text_color(t.foreground)
            .child(r.ticket.summary),
          // A long repo name is cut, never the PR's state.
          ticketCol(widths.repos, repos, t.dim),
          ticketCol(widths.pr, pr?.text ?? "", tone(pr)),
          ticketCol(widths.status, r.ticket.status, t.dim),
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
        // Actions are quiet accent text, like the Work sidebar's later steps,
        // so they read apart from tickets and existing work.
        div().w(12).flex_none().text_color(t.accent).child("+"),
        div()
          .flex_1()
          .min_w(100)
          .truncate()
          .text_color(t.accent)
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
    const empty = this.empty(rows);

    return v_flex()
      .id("tickets")
      .track_focus(this.handle)
      .key_context("Tickets")
      .on_action(
        "tickets::mark",
        (/** @type {any} */ _e, /** @type {any} */ cx) => this.mark(sel, cx),
      )
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((/** @type {any} */ e, /** @type {any} */ cx) => {
        if (this.onKey(e, rows, sel, cx)) cx.stop_propagation();
      })
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .when(!onList, (/** @type {any} */ el) =>
            el.child(
              div()
                .id("tk-back")
                .px(6)
                .rounded(5)
                .flex_none()
                .text_size(15)
                .text_color(t.dim)
                .cursor_pointer()
                .hover((/** @type {any} */ s) =>
                  s.bg(t.hover).text_color(t.foreground),
                )
                .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => {
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
          .when(this.running, (/** @type {any} */ el) =>
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
      .when(Boolean(empty), (/** @type {any} */ el) =>
        el.child(
          div()
            .px(14)
            .py(10)
            .text_size(12)
            .text_color(empty?.[1] ? t.blocked : t.dim)
            .child(empty?.[0] ?? ""),
        ),
      )
      .when(rows.length > 0, (/** @type {any} */ el) =>
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
