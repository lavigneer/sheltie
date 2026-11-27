// The Tickets popup's model (#324): its state and what starting work does, with
// no View. tickets/main.js draws it, keeps the screens and makes the calls.
// TicketsModel (at the end) is the state and the actions, tested with fake
// sources (tests/tickets-model.test.mjs); the functions above are its transitions.
//
// Data: where the ticket list and each ticket's work are. Each phase holds
// what's known by then, and moves on in this order:
//   tickets   the list is loading (`gen` numbers the loads; a reload empties it)
//   listed    the list and the repos are in; local work is being looked up
//   local     + each ticket's local work (branches, worktrees): its screens open
//   linked    + the PRs its tracker links to each ticket
//   ready     + every PR's details: all the work is known
//   failed    the load stopped in phase `from`; what it knew stays (a failure
//             after `local` keeps the local work, and so its screens)
// A reload starts from any phase (reloading), superseding the load before it.
//
// Action: idle -> running -> idle | failed, and failed -> running. While
// running, nothing else starts; going to another screen clears `failed`.

import { notify as herdrNotify } from "herdr";
import { recordFailure } from "./diagnostics.js";
import { errorText } from "./errors.js";
import {
  localCopy,
  openSpaces,
  prepareAdhoc,
  prepareStart,
  startTickets,
} from "./start.js";

/** @type {Record<string, string[]>} */
const NEXT = {
  tickets: ["listed", "failed"],
  listed: ["local", "failed"],
  local: ["linked", "failed"],
  linked: ["ready", "failed"],
  ready: [],
  failed: [],
};

// The data a reload starts with: nothing known, the list loading.
/** @param {number} gen */
export const reloading = (gen) => ({ phase: "tickets", gen });

// `data` moved to `phase`, with `fields` added. A move the table doesn't allow
// is a bug, so it throws (the load's catch turns it into `failed`).
/** @param {any} data @param {string} phase @param {Record<string, any>} [fields] */
export function advance(data, phase, fields = {}) {
  if (!NEXT[data.phase]?.includes(phase))
    throw new Error(`tickets: ${data.phase} -> ${phase}`);
  return { ...data, ...fields, phase };
}

// The data after a load fails. `shown`: the tickets on screen before a reload,
// kept on screen (the list is what it was). Each of what the load had is kept.
/** @param {any} data @param {{ shown?: any[], error: unknown }} opts */
export function loadFailed(data, { shown, error }) {
  return advance(data, "failed", {
    tickets: data.tickets ?? shown ?? [],
    repos: data.repos ?? [],
    here: data.here ?? null,
    work: data.work ?? new Map(),
    from: data.phase,
    error,
  });
}

const LOCAL_KNOWN = ["local", "linked", "ready"];

// Whether each ticket's local work is known, so its screens can open: the
// load has got that far, or failed after it.
/** @param {any} d */
export const localKnown = (d) =>
  LOCAL_KNOWN.includes(d.phase === "failed" ? d.from : d.phase);

// No work on `key`, known for sure: from its local branches and the PRs its
// tracker links while PR details are still loading, or, once ready, none at all.
/** @param {any} d @param {string} key */
export function noWork(d, key) {
  if (d.work?.get(key)?.length) return false;
  if (d.phase === "ready") return true;
  return d.phase === "linked" && !d.linked.get(key)?.length;
}

export const idleAction = () => ({ phase: "idle" });
/** @param {string} message */
export const runningAction = (message) => ({ phase: "running", message });
/** @param {unknown} error */
export const failedAction = (error) => ({ phase: "failed", error });

export const repoLabel = (/** @type {any} */ repo) => repo.slug || repo.name;

// What the actions reach outside the model: the starts, opening spaces, and how
// a failure is recorded and shown. Tests pass fakes (see ReviewsModel).
export const DEFAULT_SOURCES = {
  prepare: prepareStart,
  startAll: startTickets,
  prepareAdhoc,
  open: openSpaces,
  notify: herdrNotify,
  record: recordFailure,
};

// Where an action's changes are told: `changed` runs after each one, so the
// View can redraw (as WorkModel's lookups do).
/** @typedef {{ changed?: () => void }} On */

export class TicketsModel {
  /** @param {{ sources?: Partial<typeof DEFAULT_SOURCES> }} [opts] */
  constructor({ sources = {} } = {}) {
    this.src = { ...DEFAULT_SOURCES, ...sources };
    /** @type {any} */
    this.data = reloading(0);
    /** @type {any} */
    this.action = idleAction();
    /** @type {Set<string>} keys of the tickets marked to start together (Tab) */
    this.marked = new Set();
  }

  get running() {
    return this.action.phase === "running";
  }

  /** @param {any} data @param {On} [on] */
  setData(data, on = {}) {
    this.data = data;
    on.changed?.();
  }

  /** @param {any} action @param {On} [on] */
  setAction(action, on = {}) {
    this.action = action;
    on.changed?.();
  }

  // A load that stopped: recorded, and its data is loadFailed's. `shown` is the
  // list on screen before the reload, kept if the load had none.
  /** @param {unknown} error @param {any[] | undefined} shown @param {On} [on] */
  failLoad(error, shown, on = {}) {
    this.src.record("tickets", "load", error);
    this.setData(loadFailed(this.data, { shown, error: errorText(error) }), on);
  }

  // Going to another screen clears a failure left on the last one.
  /** @param {On} [on] */
  clearFailure(on = {}) {
    if (this.action.phase === "failed") this.setAction(idleAction(), on);
  }

  // Tab: marks the ticket to start with the others, or unmarks it.
  /** @param {{ key: string }} ticket @param {On} [on] */
  mark(ticket, on = {}) {
    if (this.running) return;
    if (!this.marked.delete(ticket.key)) this.marked.add(ticket.key);
    on.changed?.();
  }

  // Runs f as the action `message`; f's onStep moves its message on. While it
  // runs nothing else starts. An error is recorded and shown after it.
  /** @param {string} message @param {(onStep: (m: string) => void) => Promise<void>} f @param {On} [on] */
  async act(message, f, on = {}) {
    if (this.running) return;
    this.setAction(runningAction(message), on);
    try {
      await f((m) => this.setAction(runningAction(m), on));
      this.setAction(idleAction(), on);
    } catch (e) {
      this.src.record("tickets", message, e);
      this.setAction(failedAction(errorText(e)), on);
    }
  }

  /** @param {{ key: string }} ticket */
  workOf(ticket) {
    return this.data.work.get(ticket.key) ?? [];
  }

  // `repo` as a local checkout (cloned first, and the list told; see localCopy).
  /** @param {any} repo @param {(m: string) => void} onStep */
  local(repo, onStep) {
    return localCopy(repo, this.data.repos, onStep);
  }

  // Starts `tickets`, each in `target`; with a null target, each in its
  // suggested repo, and a ticket with open work is skipped (startTickets), with
  // what didn't start told. Their spaces open together, once all are ready:
  // opening one closes the popup.
  /** @param {any[]} tickets @param {any} target @param {On} [on] */
  start(tickets, target, on = {}) {
    if (this.running) return;
    if (!target && this.data.phase !== "ready")
      return this.setAction(
        failedAction("Still loading tickets' work, try again"),
        on,
      );
    const message = target
      ? `Creating worktree${tickets.length === 1 ? ` for ${tickets[0].label}` : "s"} in ${repoLabel(target)}…`
      : `Creating ${tickets.length} worktrees…`;
    return this.act(
      message,
      async (onStep) => {
        if (target) {
          const spaces = [];
          for (const ticket of tickets)
            spaces.push(
              await this.src.prepare(ticket, target, {
                work: this.workOf(ticket),
                repos: this.data.repos,
                onStep,
              }),
            );
          this.src.open(spaces);
          return;
        }
        const { results, spaces } = await this.src.startAll(
          tickets.map((ticket) => ({ ticket, repo: null })),
          {
            repos: this.data.repos,
            work: this.data.work,
            here: this.data.here,
            onStep,
          },
        );
        const left = results.filter((r) => r.status !== "started");
        if (left.length)
          this.src.notify({
            title: `${left.length} of ${results.length} tickets not started`,
            body: left.map((r) => `${r.label}: ${r.why}`).join("\n"),
            level: "warning",
          });
        this.marked.clear();
        this.src.open(spaces);
      },
      on,
    );
  }

  // Every marked ticket, each in its suggested repo (start with a null target).
  /** @param {On} [on] */
  startMarked(on = {}) {
    const tickets = (this.data.tickets ?? []).filter((/** @type {any} */ t) =>
      this.marked.has(t.key),
    );
    return this.start(tickets, null, on);
  }

  // Ad-hoc work (typed text, no ticket) in `target`, with the agent told what it is.
  /** @param {string} description @param {any} target @param {On} [on] */
  startAdhoc(description, target, on = {}) {
    return this.act(
      `Creating worktree in ${repoLabel(target)}…`,
      async (onStep) => {
        const s = await this.src.prepareAdhoc(description, target, {
          repos: this.data.repos,
          onStep,
        });
        this.src.open([s]);
      },
      on,
    );
  }
}
