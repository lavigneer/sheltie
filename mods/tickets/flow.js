// The ticket workflow after the worktree exists, for the Work sidebar:
//
//   no PR ─► draft (CI …/✗/✓, comments, conflicts) ─► ready ─► approved ─► merged ─► finished
//
// A worktree's stage is derived from its pull request every time (nothing is
// stored). The stages and the moves between them are declared once, in LADDER;
// STEPS names the stages each step is offered from, and the moves it makes.
// Each stage offers its next steps:
//   Draft PR / Fix CI / Address comments / Resolve conflicts
//             sent to the space's agent (C.agent.steps: /draft-pr, /fix-ci,
//             /address-comments, /resolve-conflicts by default). A PR that
//             conflicts with its base offers only Resolve conflicts: GitHub
//             runs no CI on it, so nothing else can get it green.
//   Ready     once CI has passed (a PR with no checks yet isn't green), it
//             doesn't conflict and nothing is unresolved; with
//             C.workflow.readyWhen "agent", also only once the agent has
//             labelled its terminal pr=ready (`hc label "$HC_TERMINAL_ID"
//             pr=ready`), a label cleared whenever an agent step is sent.
//             gh pr ready; with C.workflow.autoMerge "when-reviews-required",
//             auto-merge while reviews are still required, so it merges on
//             approval and never at once; tracker step "review"
//   Merge     when approved, or no review is required (unless
//             C.workflow.mergeWithoutReview is false), green (as for Ready)
//             and not auto-merging; asks for a second click
//             (C.workflow.confirmMerge)
//   Finish    after the merge: close its space, remove the worktree and local
//             branch (refused if anything isn't in the PR), tracker step "done"
//             unless other work on the ticket is still open

import { run } from "herdr";
import { C, settingsOf } from "./config.js";
import { assertClean, removeWorktree } from "./git.js";
import { basename, closeSpacesIn, tool } from "./lib.js";
import { markReady, mergePr, prDetails } from "./prs.js";
import { herdrSpaces } from "./spaces.js";
import { openWork, workName } from "./work.js";

/** @typedef {import("./types.js").PR} PR */
/** @typedef {import("./types.js").WorkItem} WorkItem */
/** @typedef {import("./types.js").TicketHandle} TicketHandle */
/** @typedef {import("./types.js").Repo} Repo */
/** @typedef {import("./git.js").LocalRepo} LocalRepo */
/** @typedef {import("./config.js").Settings} Settings */
/** @typedef {"success" | "error" | "warning" | "info"} Level */
/**
 * A worktree a step runs in: its folder and branch, its repo, and its ticket's
 * handle when it has one (joinWork, work.js).
 * @typedef {{ path: string, branch: string | null, repo: LocalRepo, handle?: TicketHandle | null }} Worktree
 */
/**
 * A worktree's last step (WorkModel.steps; see STEP below).
 * @typedef {{ phase: string, text?: string, at?: number, staleAt?: number }} StepLast
 */
/**
 * What a step's `when` and `confirm` read: whether the PR conflicts, is green
 * (CI passed and GitHub can merge), whether its agent is busy or done, and the
 * repo's workflow settings.
 * @typedef {{ conflicts: boolean, green: boolean, working: boolean, agentDone: boolean, workflow: Settings["workflow"] }} StepContext
 */
/**
 * A row of STEPS (see the table's comment).
 * @typedef {{
 *   id: string,
 *   kind: "agent" | "direct",
 *   label: string | ((pr: PR) => string),
 *   short?: string | ((pr: PR) => string),
 *   from: string[],
 *   to?: string[],
 *   when?: (pr: PR, x: StepContext) => boolean,
 *   confirm?: (x: StepContext) => boolean,
 *   run?: (w: Worktree, pr: PR, work: WorkItem[]) => Promise<string> | string,
 * }} FlowStep
 */

// --- Stage ------------------------------------------------------------------

// Every stage a PR can be in (stageOf), in the order the Work sidebar groups
// them, with `name` and the stages a PR can move to from it (`next`). A move is
// made by a step (STEPS' `to`) or by hand on GitHub. `told`: the notice when a
// PR enters the stage (prEvents).
/** @type {Record<string, { name: string, next: string[], told?: { title: string, level: Level, body?: string } }>} */
export const LADDER = {
  "no-pr": { name: "No PR", next: ["draft", "in-review", "approved"] },
  draft: {
    name: "Draft",
    next: ["in-review", "approved", "merged", "closed"],
  },
  "in-review": {
    name: "In review",
    next: ["draft", "approved", "merged", "closed"],
  },
  approved: {
    name: "Approved",
    next: ["draft", "in-review", "merged", "closed"],
  },
  merged: {
    name: "Merged",
    next: [],
    told: {
      title: "merged",
      level: "success",
      body: "Finish removes the worktree and resolves the ticket.",
    },
  },
  closed: { name: "Closed", next: ["draft", "in-review", "approved"] },
};

// pr: prDetails() (`unresolved`: a count, or null when unknown).
export function stageOf(/** @type {PR | null} */ pr) {
  if (!pr) return "no-pr";
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (pr.draft) return "draft";
  return pr.review === "APPROVED" ? "approved" : "in-review";
}

// What a PR shows at a width (`span`: "full" | "short" | "glyph"): `head`,
// which may truncate, then `tail`, kept whole — at full width
// "#881 draft approved" and the end that carries the tone (checks,
// conflicts; a "●" when only the review does); short, the one state that
// matters most as a word ("#881 CI failed"), with no tail; at glyph width,
// that state's glyph alone. `text` is the whole label at any width (for a
// tooltip), `glyph` the state's glyph, `tone` "bad" | "good" | null.
export function prLabel(/** @type {PR | null} */ pr, span = "full") {
  if (!pr) return null;
  const parts = [`#${pr.number}`];
  const tail = [];
  if (pr.state === "MERGED") parts.push("merged");
  else if (pr.state === "CLOSED") parts.push("closed");
  else {
    if (pr.draft) parts.push("draft");
    if (pr.review === "APPROVED") parts.push("approved");
    else if (pr.review === "CHANGES_REQUESTED") parts.push("changes requested");
    else if (!pr.draft && !pr.review) parts.push("no review needed");
    else if (!pr.draft) parts.push("in review");
    if (pr.checks) {
      // GitHub's icon and count of passed checks: "✗ 2/5".
      const icon = /** @type {Record<string, string>} */ ({
        failed: "✗",
        pending: "◌",
        passed: "✓",
      })[pr.checks];
      tail.push(
        pr.checksTotal ? `${icon} ${pr.checksPassed}/${pr.checksTotal}` : icon,
      );
    }
  }
  const conflicts = pr.state === "OPEN" && pr.mergeable === "CONFLICTING";
  if (conflicts) tail.push("conflicts");
  const bad =
    conflicts || pr.checks === "failed" || pr.review === "CHANGES_REQUESTED";
  const good =
    pr.state === "MERGED" ||
    // Ready to merge: approved, or needing no review, with checks passed.
    (pr.state === "OPEN" &&
      !pr.draft &&
      (pr.review === "APPROVED" || !pr.review) &&
      pr.checks === "passed");
  /** @type {"bad" | "good" | null} */
  const tone = bad ? "bad" : good ? "good" : null;
  // When space is short: the one state that matters most, as a word and as
  // a glyph.
  const [word, glyph] =
    pr.state === "MERGED"
      ? ["merged", "◆"]
      : pr.state === "CLOSED"
        ? ["closed", "×"]
        : conflicts
          ? ["conflicts", "!"]
          : pr.checks === "failed"
            ? ["CI failed", "✗"]
            : pr.review === "CHANGES_REQUESTED"
              ? ["changes", "±"]
              : pr.draft
                ? ["draft", "◌"]
                : pr.review === "APPROVED"
                  ? ["approved", "✓"]
                  : ["in review", "◑"];
  const full = span === "full";
  return {
    text: [...parts, ...tail].join(" "),
    head: full
      ? parts.join(" ")
      : span === "short"
        ? `#${pr.number} ${word}`
        : glyph,
    tail: !full ? "" : tail.length ? tail.join(" ") : tone ? "●" : "",
    tone,
    glyph,
  };
}

// The theme key for a prLabel's tone: "blocked" | "done" | "muted".
export const toneKey = (/** @type {"bad" | "good" | null} */ tone) =>
  tone === "bad" ? "blocked" : tone === "good" ? "done" : "muted";

// Whether a PR is offered Merge: CI passed (not failed, pending or missing) on
// a PR GitHub says can merge, nothing unresolved, auto-merge off, and approved,
// or needing no review at all (a repo without required reviews: reviewDecision
// is empty) unless the workflow's mergeWithoutReview is false. The stages it's
// offered from are the Merge step's (STEPS). `workflow`: the repo's
// (settingsOf(repo).workflow).
export function canMerge(/** @type {PR} */ pr, workflow = C.workflow) {
  if (pr.checks !== "passed" || pr.mergeable !== "MERGEABLE") return false;
  if ((pr.unresolved ?? 0) > 0 || pr.autoMerge) return false;
  if (pr.review === "APPROVED") return true;
  return pr.review === null && workflow.mergeWithoutReview !== false;
}

// What changed on a PR worth telling, from one snapshot (`was`) to the next
// (`pr`): [{ title, level: "success" | "error" | "warning", body? }]. A
// conflict compares against `was.settled` (the last mergeable GitHub worked
// out), so it's told once, not again after every push that doesn't fix it.
// A move along LADDER is told by the stage it enters (`told`); CI, comments,
// conflicts and reviews are told from the field that changed.
export function prEvents(/** @type {PR} */ was, /** @type {PR} */ pr) {
  /** @type {{ title: string, level: Level, body?: string }[]} */ const events =
    [];
  const add = (
    /** @type {string} */ title,
    /** @type {Level} */ level,
    /** @type {string | undefined} */ body = undefined,
  ) => events.push({ title, level, body });
  const from = stageOf(was);
  const to = stageOf(pr);
  const entered = LADDER[from].next.includes(to) ? LADDER[to].told : undefined;
  if (was.checks === "pending" && pr.checks === "passed")
    add(
      "CI passed",
      "success",
      pr.draft ? "Ready to mark ready for review." : undefined,
    );
  if (was.checks === "pending" && pr.checks === "failed")
    add("CI failed", "error");
  if (
    pr.state === "OPEN" &&
    pr.mergeable === "CONFLICTING" &&
    was.settled !== "CONFLICTING"
  )
    add(
      "merge conflicts",
      "warning",
      "It conflicts with its base, so CI won't run: Resolve conflicts.",
    );
  const added = (pr.unresolved ?? 0) - (was.unresolved ?? 0);
  if (added > 0)
    add(`${added} new review comment${added === 1 ? "" : "s"}`, "warning");
  if (was.review !== pr.review && pr.review === "APPROVED")
    add(
      "approved",
      "success",
      pr.autoMerge ? "Auto-merge will merge it." : undefined,
    );
  if (was.review !== pr.review && pr.review === "CHANGES_REQUESTED")
    add("changes requested", "warning");
  if (entered) add(entered.title, entered.level, entered.body);
  return events;
}

// The workflow's steps, in the order they're offered: one table that both
// nextSteps (which to offer) and runStep (what each does) read, so a step is
// added or changed in one place. Each has:
//   id, kind      "agent" steps send C.agent.steps[id] to the space's agent
//                 (offered only when that's set and the agent isn't working);
//                 "direct" ones run `run`
//   from          the LADDER stages it's offered from
//   to            the stages it moves the PR to (none: it leaves the ticket's
//                 PR alone, or tears it down); each must be a LADDER move
//   label         text, or a function of the PR
//   when(pr, x)   whether it's offered now, beyond `from`; x: { conflicts,
//                 green, working, agentDone, workflow }
//   confirm(x)    whether it asks for a second click (direct steps)
//   run(w, pr, work)  for direct steps: does it, returns a note
// A PR that conflicts with its base offers only Resolve conflicts: GitHub
// runs no CI on it, so nothing else can get it green.
const confirmFinish = (/** @type {StepContext} */ x) =>
  x.workflow.confirmFinish !== false;
const OPEN = ["draft", "in-review", "approved"];
/** @type {FlowStep[]} */
export const STEPS = [
  {
    id: "draft-pr",
    kind: "agent",
    label: "Draft PR",
    from: ["no-pr"],
    to: ["draft"],
  },
  {
    id: "resolve-conflicts",
    kind: "agent",
    label: "Resolve conflicts",
    short: "Conflicts",
    from: OPEN,
    when: (_pr, x) => x.conflicts,
  },
  {
    id: "fix-ci",
    kind: "agent",
    label: "Fix CI",
    from: OPEN,
    when: (pr, x) => !x.conflicts && pr.checks === "failed",
  },
  {
    id: "address-comments",
    kind: "agent",
    label: (pr) =>
      (pr.unresolved ?? 0) > 0
        ? `Address ${pr.unresolved} comment${pr.unresolved === 1 ? "" : "s"}`
        : "Address review",
    short: (pr) =>
      (pr.unresolved ?? 0) > 0
        ? `${pr.unresolved} comment${pr.unresolved === 1 ? "" : "s"}`
        : "Review",
    from: OPEN,
    when: (pr, x) =>
      !x.conflicts &&
      ((pr.unresolved ?? 0) > 0 || pr.review === "CHANGES_REQUESTED"),
  },
  {
    id: "ready",
    kind: "direct",
    label: "Ready",
    from: ["draft"],
    to: ["in-review", "approved"],
    when: (pr, x) =>
      x.green &&
      !pr.unresolved &&
      (x.workflow.readyWhen !== "agent" || x.agentDone) &&
      !x.working,
    run: ready,
  },
  {
    id: "merge",
    kind: "direct",
    label: "Merge",
    from: ["in-review", "approved"],
    to: ["merged"],
    when: (pr, x) => !x.working && canMerge(pr, x.workflow),
    confirm: ({ workflow }) => workflow.confirmMerge !== false,
    run: async (w, pr) => {
      await mergePr(/** @type {string} */ (w.repo.slug), pr.number);
      return "merged";
    },
  },
  {
    id: "finish",
    kind: "direct",
    label: "Finish",
    from: ["merged"],
    to: [],
    confirm: confirmFinish,
    run: (w, pr, work) => finish(w, pr, work, true),
  },
  {
    id: "clean-up",
    kind: "direct",
    label: "Clean up",
    from: ["closed"],
    to: [],
    confirm: confirmFinish,
    run: (w, pr, work) => finish(w, pr, work, false),
  },
];

// The next steps for a worktree: [{ id, label, short, kind: "agent" | "direct",
// confirm }]; `short`: the label when space is short.
// `working`: its agent is busy, so nothing is sent to it and the PR isn't
// marked Ready or merged while the agent may still be iterating on it. `agentDone`: its
// agent says the PR is done (see agentDone in spaces.js), which Ready waits for with
// readyWhen "agent". `repo`: whose workflow settings apply (settingsOf).
/** @param {PR | null} pr @param {{ working?: boolean, agentDone?: boolean, repo?: Repo | null }} [opts] */
export function nextSteps(
  pr,
  { working = false, agentDone = false, repo = null } = {},
) {
  const stage = stageOf(pr);
  const x = {
    conflicts: pr?.mergeable === "CONFLICTING",
    // Green: CI ran and passed (no checks: not started yet, or it never will
    // because the PR conflicts) on a PR GitHub says can merge (not "UNKNOWN":
    // that's only until GitHub has worked it out, soon after a push).
    green: pr?.checks === "passed" && pr.mergeable === "MERGEABLE",
    working,
    agentDone,
    workflow: settingsOf(repo).workflow,
  };
  const steps = [];
  for (const s of STEPS) {
    if (!s.from.includes(stage)) continue;
    if (
      s.kind === "agent" &&
      (working ||
        !(/** @type {Record<string, string>} */ (C.agent.steps)[s.id]))
    )
      continue;
    if (s.when && !s.when(/** @type {PR} */ (pr), x)) continue;
    // A step with a label or when is offered from a stage with a PR (see from).
    const label =
      typeof s.label === "function" ? s.label(/** @type {PR} */ (pr)) : s.label;
    const short =
      typeof s.short === "function" ? s.short(/** @type {PR} */ (pr)) : s.short;
    /** @type {{ id: string, label: string, short: string, kind: string, confirm?: boolean }} */
    const step = { id: s.id, label, short: short ?? label, kind: s.kind };
    if (s.confirm) step.confirm = s.confirm(x);
    steps.push(step);
  }
  return steps;
}

// How long a new space's agent may take to start working.
export const START_MS = 30_000;

// Whether a new space's agent still counts as starting (`bornAt`: when its
// space appeared, null if it didn't while we run): until it first works or
// START_MS passes, so it isn't offered Draft PR before it has begun.
export const stillStarting = (
  /** @type {number | null} */ bornAt,
  /** @type {string | null} */ status,
  /** @type {number} */ now,
) => bornAt != null && status !== "working" && now - bornAt < START_MS;

// A worktree's last step (WorkModel.steps: { phase, text, at, staleAt }) is in
// one of these states. This is the one place they're named: rowSteps, the
// rows' display (work-rows.js), the step runner (work/main.js) and the PR
// refresh that clears a stale mark (WorkModel.lookups) all read them here.
//   running  a step is being run: no steps are offered meanwhile
//   stale    done, and its PR not looked up since (staleAt): no steps are
//            offered, or the same one would be offered again; the next PR
//            lookup started after the step answered (clearStale) makes it done
//   done     done, its PR current: its note fades after NOTE_MS
//   failed   the step failed: its note stays until the next step
export const STEP = Object.freeze({
  RUNNING: "running",
  STALE: "stale",
  DONE: "done",
  FAILED: "failed",
});

// The state of `last` (a worktree's last step), or null when none has run.
export function stepState(/** @type {StepLast | null | undefined} */ last) {
  if (!last) return null;
  if (last.phase === "running") return STEP.RUNNING;
  if (last.phase === "failed") return STEP.FAILED;
  return last.staleAt != null ? STEP.STALE : STEP.DONE;
}

// Whether a state is a step that succeeded (its note is a success note).
export const succeeded = (/** @type {string | null} */ state) =>
  state === STEP.DONE || state === STEP.STALE;

// The steps the runner writes: running, then done (stale until the PR is
// looked up again) or failed. `at`: when the step answered.
export const stepRunning = (/** @type {string} */ text) => ({
  phase: "running",
  text,
});
export const stepDone = (
  /** @type {string} */ text,
  /** @type {number} */ at,
) => ({
  phase: "done",
  text,
  at,
  staleAt: at,
});
export const stepFailed = (
  /** @type {string} */ text,
  /** @type {number} */ at,
) => ({
  phase: "failed",
  text,
  at,
});

// Clears a stale step's mark when a PR lookup started at `asked` lands: a lookup
// started after the step answered (staleAt <= asked) counts as a refresh. A
// failed lookup counts too, so a row isn't held back for a retry. True when it
// cleared.
export function clearStale(
  /** @type {StepLast} */ last,
  /** @type {number} */ asked,
) {
  if (
    stepState(last) !== STEP.STALE ||
    /** @type {number} */ (last.staleAt) > asked
  )
    return false;
  delete last.staleAt;
  return true;
}

// A worktree row's next steps, or none while they'd mislead. `hub`: the row is
// a repo's hub. `pr`, `lookup`: its PR and the store's lookup entry for it (no
// PR before the lookup answers means "not known yet", not "no PR": guessing
// Draft PR would flash a wrong, clickable button). `last`: its last step (see
// STEP): none while it runs or while its PR is stale after it. `status`: its
// space's agent status. `bornAt`, `now`: see stillStarting. `agentDone`, `repo`:
// see nextSteps.
/** @param {{ hub?: boolean, pr?: PR | null, lookup?: { state: string } | null, last?: StepLast | null, status?: string | null, bornAt?: number | null, now?: number, agentDone?: boolean, repo?: Repo | null }} row */
export function rowSteps({
  hub = false,
  pr = null,
  lookup = null,
  last = null,
  status = null,
  bornAt = null,
  now = Date.now(),
  agentDone = false,
  repo = null,
}) {
  if (hub) return [];
  if (!pr && (!lookup || lookup.state === "failed")) return [];
  const state = stepState(last);
  if (state === STEP.RUNNING || state === STEP.STALE) return [];
  return nextSteps(pr, {
    working: status === "working" || stillStarting(bornAt, status, now),
    agentDone,
    repo,
  });
}

// --- The agent --------------------------------------------------------------

// Sends a step's message to the worktree's agent, or starts one with it.
async function tellAgent(/** @type {Worktree} */ w, /** @type {string} */ id) {
  const text = /** @type {Record<string, string>} */ (C.agent.steps)[id];
  const live = herdrSpaces();
  const space = live.spaceOf(w.path);
  const address = live.agentIn(space);
  if (address && space) {
    // The agent has more to do: Ready waits until it says pr=ready again.
    // (Best effort: an agent that can't be labelled can't be sent to either.)
    await tool("hc", ["label", address, "pr="]).catch(() => null);
    const r = await tool("hc", ["send", address, text]);
    if (r.code !== 0)
      throw new Error(
        `couldn't reach the agent: ${(r.stderr || "").trim().split("\n")[0]}`,
      );
    run("space.select", { id: space.id });
  } else if (space)
    run("tab.new", {
      space: space.id,
      folder: w.path,
      argv: C.agent.argv,
      task: text,
    });
  else
    run("space.new", {
      name: w.handle?.label ?? basename(w.path),
      folder: w.path,
      argv: C.agent.argv,
      task: text,
    });
  return `sent ${text.split("\n")[0]}`;
}

// --- Steps ------------------------------------------------------------------

// Runs step `id` for worktree `w` ({ path, branch, handle, repo }) whose PR is
// `pr`. `work`: the ticket's work (WorkItem[], joinWork: worktrees, branches
// and tracker-linked PRs, checked out here or not), to tell whether the
// ticket still has open work. Returns a short note, or throws.
export async function runStep(
  /** @type {string} */ id,
  /** @type {Worktree} */ w,
  /** @type {PR | null} */ pr,
  /** @type {WorkItem[]} */ work = [],
) {
  const step = STEPS.find((s) => s.id === id);
  if (!step) throw new Error(`unknown step ${id}`);
  // Only a direct step runs here, and those are offered only with a PR (see from).
  return step.run
    ? step.run(w, /** @type {PR} */ (pr), work)
    : tellAgent(w, id);
}

// Ready: out of draft; with autoMerge "when-reviews-required", auto-merge
// while reviews are still required; tracker step "review".
async function ready(/** @type {Worktree} */ w, /** @type {PR} */ pr) {
  const repoSlug = /** @type {string} */ (w.repo.slug);
  await markReady(repoSlug, pr.number);
  const notes = ["ready for review"];
  // Auto-merge only waits for what the repo requires; without required
  // reviews it would merge at once, so then leave merging to the Merge step.
  if (settingsOf(w.repo).workflow.autoMerge === "when-reviews-required") {
    const now = await prDetails(repoSlug, pr.number, null, {
      requiredOnly: settingsOf(w.repo).requiredChecksOnly,
    });
    if (
      now?.review === "REVIEW_REQUIRED" ||
      now?.review === "CHANGES_REQUESTED"
    ) {
      await mergePr(repoSlug, pr.number, { auto: true });
      notes.push("auto-merge on approval");
    }
  }
  if (w.handle) {
    const moved = await w.handle.move("review");
    if (moved) notes.push(moved);
  }
  return notes.join(" · ");
}

// Finish (`merged`) / Clean up: close its spaces, remove the worktree and
// branch; after a merge, tracker step "done" unless other work on the ticket
// (any branch or PR not merged or closed, wherever it is) is still open.
async function finish(
  /** @type {Worktree} */ w,
  /** @type {PR | null} */ pr,
  /** @type {WorkItem[]} */ work,
  /** @type {boolean} */ merged,
) {
  await assertClean(w.path, pr?.head ?? null);
  // Its spaces end with it (the agent's work is in the PR by now).
  closeSpacesIn(w.path);
  await removeWorktree(w.repo, w.path, w.branch, pr?.head ?? null);
  const notes = ["worktree removed"];
  if (merged && w.handle) {
    const open = openWork(work, w, pr);
    if (open.length)
      notes.push(
        `${w.handle.label} left open: ${open.map(workName).join(", ")} still in progress`,
      );
    else {
      const moved = await w.handle.move("done");
      if (moved) notes.push(moved);
    }
  }
  return notes.join(" · ");
}
