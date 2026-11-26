// Herdr's live data (spaces, panes, agents, terminals), read through one
// snapshot per pass. Each of Herdr's spaces(), panes(), agents() and
// terminals() copies the app's state into the script, so asking per row makes
// a render cost rows x that state; a snapshot reads each at most once, when
// first needed, and indexes it. Take a new one per pass (a render, a command,
// a step): it doesn't follow later changes. Nothing here takes a snapshot on
// a caller's behalf, so a pass can't take a second one by forgetting to pass
// its own.
//
// Two adapters: herdrSpaces() reads the app; fixtureSpaces() reads plain
// arrays (tests).

import { agents, panes, spaces, terminals } from "herdr";
import { C } from "./config.js";
import { basename, inside } from "./lib.js";

/** @typedef {{ spaces: () => any[], panes: () => any[], agents: () => any[], terminals: () => any[] }} Source */

/** A snapshot of the app's live data. */
export const herdrSpaces = () => snapshot({ spaces, panes, agents, terminals });

/**
 * A snapshot of fixed data, for tests.
 * @param {{ spaces?: any[], panes?: any[], agents?: any[], terminals?: any[] }} data
 */
export const fixtureSpaces = (data) =>
  snapshot({
    spaces: () => data.spaces ?? [],
    panes: () => data.panes ?? [],
    agents: () => data.agents ?? [],
    terminals: () => data.terminals ?? [],
  });

/** @typedef {ReturnType<typeof snapshot>} Spaces */

/** @param {Source} source */
function snapshot(source) {
  /** @type {any} */
  const got = {};
  /** @template T @param {string} k @param {() => T} f @returns {T} */
  const once = (k, f) => {
    if (!(k in got)) got[k] = f();
    return got[k];
  };
  /** @returns {any[]} */
  const local = () =>
    once("local", () => source.spaces().filter((s) => !s.machine));
  /** @param {{ tabs: { id: string }[] }} space @returns {any[]} */
  const panesOf = (space) => {
    const byTab = once("byTab", () => {
      const m = new Map();
      for (const p of source.panes()) {
        if (!m.has(p.tab)) m.set(p.tab, []);
        m.get(p.tab).push(p);
      }
      return m;
    });
    return space.tabs.flatMap((t) => byTab.get(t.id) ?? []);
  };
  /** @param {string} address */
  const terminal = (address) =>
    once(
      "byAddress",
      () => new Map(source.terminals().map((t) => [t.address, t])),
    ).get(address);
  const found = new Map();

  const s = {
    // The local spaces (not other machines').
    get local() {
      return local();
    },
    // The focused space's id, or null.
    get active() {
      return local().find((x) => x.active)?.id ?? null;
    },

    // The local space for `dir`: its start folder, else any of its
    // terminals. Folders inside `except` don't count as in `dir` (a repo's
    // main checkout holds its worktrees: see hubExcept in git.js). A space
    // started in a folder above `dir` or inside `except` belongs there,
    // wherever its terminals are: a hub's space is never one of its
    // worktrees', nor the other way round. Found once per snapshot.
    /** @param {string} dir @param {string[]} [except] */
    spaceOf(dir, except = []) {
      const key = `${dir}\0${except.join("\0")}`;
      if (!found.has(key)) found.set(key, find(dir, except) ?? null);
      return found.get(key) ?? undefined;
    },

    // The agent terminal in a space: one reporting its status (Claude Code
    // does), else one running the configured agent program, else one
    // labelled agent=… (`hc label`; the demo's fake agent does that).
    /** @param {any} space */
    agentIn(space) {
      if (!space) return null;
      const reported = once("agents", () => source.agents()).find(
        (a) => a.space === space.id,
      );
      if (reported) return reported.address;
      const ours = basename(C.agent.argv[0]);
      const here = panesOf(space).filter((p) => p.terminal);
      const byProgram = here.find((p) => p.program?.key === ours);
      if (byProgram) return byProgram.terminal;
      return (
        here.find((p) => terminal(p.terminal)?.labels?.agent)?.terminal ?? null
      );
    },

    // Whether the agent terminal in a space says its PR is done: it has the
    // label pr=ready.
    /** @param {any} space */
    agentDone(space) {
      const address = s.agentIn(space);
      if (!address) return false;
      return terminal(address)?.labels?.pr === "ready";
    },
  };

  /** @param {string} dir @param {string[]} except */
  function find(dir, except) {
    /** @param {string | null | undefined} p */
    const ok = (p) =>
      !!p && inside(p, dir) && !except.some((e) => inside(p, e));
    const byFolder = local().find((x) => ok(x.folder));
    if (byFolder) return byFolder;
    /** @param {string | null | undefined} f */
    const elsewhere = (f) =>
      !!f &&
      ((f !== dir && inside(dir, f)) || except.some((e) => inside(f, e)));
    return local().find(
      (x) => !elsewhere(x.folder) && panesOf(x).some((p) => ok(p.cwd)),
    );
  }

  return s;
}
