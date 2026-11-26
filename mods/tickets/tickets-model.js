// The Tickets popup's state, with no View (tickets/main.js draws it and makes
// the calls), so its transitions are tested directly (tests/tickets-model.test.mjs).
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

const NEXT = {
  tickets: ["listed", "failed"],
  listed: ["local", "failed"],
  local: ["linked", "failed"],
  linked: ["ready", "failed"],
  ready: [],
  failed: [],
};

// The data a reload starts with: nothing known, the list loading.
export const reloading = (gen) => ({ phase: "tickets", gen });

// `data` moved to `phase`, with `fields` added. A move the table doesn't allow
// is a bug, so it throws (the load's catch turns it into `failed`).
export function advance(data, phase, fields = {}) {
  if (!NEXT[data.phase]?.includes(phase))
    throw new Error(`tickets: ${data.phase} -> ${phase}`);
  return { ...data, ...fields, phase };
}

// The data after a load fails. `shown`: the tickets on screen before a reload,
// kept on screen (the list is what it was). Each of what the load had is kept.
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
export const localKnown = (d) =>
  LOCAL_KNOWN.includes(d.phase === "failed" ? d.from : d.phase);

// No work on `key`, known for sure: from its local branches and the PRs its
// tracker links while PR details are still loading, or, once ready, none at all.
export function noWork(d, key) {
  if (d.work?.get(key)?.length) return false;
  if (d.phase === "ready") return true;
  return d.phase === "linked" && !d.linked.get(key)?.length;
}

export const idleAction = () => ({ phase: "idle" });
export const runningAction = (message) => ({ phase: "running", message });
export const failedAction = (error) => ({ phase: "failed", error });
