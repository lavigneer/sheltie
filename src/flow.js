// The ticket workflow after the worktree exists, for the Work sidebar:
//
//   no PR ─► draft (CI …/✗/✓, comments, conflicts) ─► ready ─► approved ─► merged ─► finished
//
// A worktree's stage is derived from its pull request every time (nothing is
// stored), and each stage offers its next steps:
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

import { agents, panes, run, spaces, terminals } from "herdr";
import { C, settingsOf } from "./config.js";
import { assertClean, removeWorktree, sameSlug } from "./git.js";
import { basename, inside, spaceFor, tool } from "./lib.js";
import { markReady, mergePr, prDetails } from "./prs.js";

// --- Stage ------------------------------------------------------------------

// pr: prDetails() (`unresolved`: a count, or null when unknown).
export function stageOf(pr) {
  if (!pr) return "no-pr";
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (pr.draft) return "draft";
  return pr.review === "APPROVED" ? "approved" : "in-review";
}

// "#881 draft approved ✓ 3/3" (or "#881 draft conflicts") and a tone for
// coloring: "bad" | "good" | null. `tail` is the end of `text` that carries
// the tone (checks, conflicts; a "●" when only the review does), kept
// whole where the line is too narrow for all of it.
export function prLabel(pr) {
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
    if (pr.checks) {
      // GitHub's icon and count of passed checks: "✗ 2/5".
      const icon = { failed: "✗", pending: "◌", passed: "✓" }[pr.checks];
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
    (pr.review === "APPROVED" && pr.checks === "passed");
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
  return {
    text: [...parts, ...tail].join(" "),
    head: parts.join(" "),
    tail: tail.length ? tail.join(" ") : tone ? "●" : "",
    tone,
    short: `#${pr.number} ${word}`,
    glyph,
  };
}

// Whether a PR is offered Merge: open, ready, CI passed (not failed, pending
// or missing) on a PR GitHub says can merge, nothing unresolved, auto-merge
// off, and approved, or needing no review at all (a repo without required
// reviews: reviewDecision is empty) unless the workflow's mergeWithoutReview
// is false. `workflow`: the repo's (settingsOf(repo).workflow).
export function canMerge(pr, workflow = C.workflow) {
  const stage = stageOf(pr);
  if (stage !== "approved" && stage !== "in-review") return false;
  if (pr.checks !== "passed" || pr.mergeable !== "MERGEABLE") return false;
  if (pr.unresolved > 0 || pr.autoMerge) return false;
  if (pr.review === "APPROVED") return true;
  return pr.review === null && workflow.mergeWithoutReview !== false;
}

// What changed on a PR worth telling, from one snapshot (`was`) to the next
// (`pr`): [{ title, level: "success" | "error" | "warning", body? }]. A
// conflict compares against `was.settled` (the last mergeable GitHub worked
// out), so it's told once, not again after every push that doesn't fix it.
export function prEvents(was, pr) {
  const events = [];
  const add = (title, level, body) => events.push({ title, level, body });
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
  if (was.state !== "MERGED" && pr.state === "MERGED")
    add(
      "merged",
      "success",
      "Finish removes the worktree and resolves the ticket.",
    );
  return events;
}

// The workflow's steps, in the order they're offered: one table that both
// nextSteps (which to offer) and runStep (what each does) read, so a step is
// added or changed in one place. Each has:
//   id, kind      "agent" steps send C.agent.steps[id] to the space's agent
//                 (offered only when that's set and the agent isn't working);
//                 "direct" ones run `run`
//   label         text, or a function of the PR
//   when(pr, x)   whether it's offered now; x: { stage, open, conflicts,
//                 green, working, agentDone, workflow }
//   confirm(x)    whether it asks for a second click (direct steps)
//   run(w, pr, work)  for direct steps: does it, returns a note
// A PR that conflicts with its base offers only Resolve conflicts: GitHub
// runs no CI on it, so nothing else can get it green.
const confirmFinish = ({ workflow }) => workflow.confirmFinish !== false;
const STEPS = [
  {
    id: "draft-pr",
    kind: "agent",
    label: "Draft PR",
    when: (_pr, x) => x.stage === "no-pr",
  },
  {
    id: "resolve-conflicts",
    kind: "agent",
    label: "Resolve conflicts",
    short: "Conflicts",
    when: (_pr, x) => x.open && x.conflicts,
  },
  {
    id: "fix-ci",
    kind: "agent",
    label: "Fix CI",
    when: (pr, x) => x.open && !x.conflicts && pr.checks === "failed",
  },
  {
    id: "address-comments",
    kind: "agent",
    label: (pr) =>
      pr.unresolved > 0
        ? `Address ${pr.unresolved} comment${pr.unresolved === 1 ? "" : "s"}`
        : "Address review",
    short: (pr) =>
      pr.unresolved > 0
        ? `${pr.unresolved} comment${pr.unresolved === 1 ? "" : "s"}`
        : "Review",
    when: (pr, x) =>
      x.open &&
      !x.conflicts &&
      (pr.unresolved > 0 || pr.review === "CHANGES_REQUESTED"),
  },
  {
    id: "ready",
    kind: "direct",
    label: "Ready",
    when: (pr, x) =>
      x.stage === "draft" &&
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
    when: (pr, x) => !x.working && canMerge(pr, x.workflow),
    confirm: ({ workflow }) => workflow.confirmMerge !== false,
    run: async (w, pr) => {
      await mergePr(w.repo.slug, pr.number);
      return "merged";
    },
  },
  {
    id: "finish",
    kind: "direct",
    label: "Finish",
    when: (_pr, x) => x.stage === "merged",
    confirm: confirmFinish,
    run: (w, pr, work) => finish(w, pr, work, true),
  },
  {
    id: "clean-up",
    kind: "direct",
    label: "Clean up",
    when: (_pr, x) => x.stage === "closed",
    confirm: confirmFinish,
    run: (w, pr, work) => finish(w, pr, work, false),
  },
];

// The next steps for a worktree: [{ id, label, short, kind: "agent" | "direct",
// confirm }]; `short`: the label when space is short.
// `working`: its agent is busy, so nothing is sent to it and the PR isn't
// marked Ready or merged while the agent may still be iterating on it. `agentDone`: its
// agent says the PR is done (see agentSaysDone), which Ready waits for with
// readyWhen "agent". `repo`: whose workflow settings apply (settingsOf).
export function nextSteps(
  pr,
  { working = false, agentDone = false, repo = null } = {},
) {
  const stage = stageOf(pr);
  const x = {
    stage,
    open: ["draft", "in-review", "approved"].includes(stage),
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
    if (s.kind === "agent" && (working || !C.agent.steps?.[s.id])) continue;
    if (!s.when(pr, x)) continue;
    const label = typeof s.label === "function" ? s.label(pr) : s.label;
    const short = typeof s.short === "function" ? s.short(pr) : s.short;
    const step = { id: s.id, label, short: short ?? label, kind: s.kind };
    if (s.confirm) step.confirm = s.confirm(x);
    steps.push(step);
  }
  return steps;
}

// --- The agent --------------------------------------------------------------

// The agent terminal in a space: one reporting its status (Claude Code does),
// else one running the configured agent program, else one labelled agent=…
// (`hc label`; the demo's fake agent does that).
export function agentIn(space) {
  if (!space) return null;
  const tabs = new Set(space.tabs.map((t) => t.id));
  const reported = agents().find((a) => a.space === space.id);
  if (reported) return reported.address;
  const ours = basename(C.agent.argv[0]);
  const here = panes().filter((p) => tabs.has(p.tab) && p.terminal);
  const byProgram = here.find((p) => p.program?.key === ours);
  if (byProgram) return byProgram.terminal;
  const labelled = new Set(
    terminals()
      .filter((t) => t.labels?.agent)
      .map((t) => t.address),
  );
  return (
    here.find((p) => p.terminal && labelled.has(p.terminal))?.terminal ?? null
  );
}

// Whether the agent terminal in a space says its PR is done: it has the
// label pr=ready.
export function agentSaysDone(space) {
  const address = agentIn(space);
  if (!address) return false;
  return terminals().find((t) => t.address === address)?.labels?.pr === "ready";
}

// Sends a step's message to the worktree's agent, or starts one with it.
async function tellAgent(w, id) {
  const text = C.agent.steps[id];
  const space = spaceFor(w.path);
  const address = agentIn(space);
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
export async function runStep(id, w, pr, work = []) {
  const step = STEPS.find((s) => s.id === id);
  if (!step) throw new Error(`unknown step ${id}`);
  return step.run ? step.run(w, pr, work) : tellAgent(w, id);
}

// Ready: out of draft; with autoMerge "when-reviews-required", auto-merge
// while reviews are still required; tracker step "review".
async function ready(w, pr) {
  await markReady(w.repo.slug, pr.number);
  const notes = ["ready for review"];
  // Auto-merge only waits for what the repo requires; without required
  // reviews it would merge at once, so then leave merging to the Merge step.
  if (settingsOf(w.repo).workflow.autoMerge === "when-reviews-required") {
    const now = await prDetails(w.repo.slug, pr.number);
    if (
      now?.review === "REVIEW_REQUIRED" ||
      now?.review === "CHANGES_REQUESTED"
    ) {
      await mergePr(w.repo.slug, pr.number, { auto: true });
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
async function finish(w, pr, work, merged) {
  await assertClean(w.path, pr?.head ?? null);
  // Its spaces end with it (the agent's work is in the PR by now).
  for (const s of spaces())
    if (!s.machine && s.folder && inside(s.folder, w.path))
      run("space.close", { id: s.id, confirmed: true });
  await removeWorktree(w.repo, w.path, w.branch, pr?.head ?? null);
  const notes = ["worktree removed"];
  if (merged && w.handle) {
    const open = work.filter(
      (i) => !isThis(i, w, pr) && !["merged", "closed"].includes(stageOf(i.pr)),
    );
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

// Whether work item `i` is worktree `w` (with PR `pr`) itself.
const isThis = (i, w, pr) =>
  i.worktree === w.path ||
  (i.repo.path === w.repo.path && i.branch === w.branch) ||
  (pr != null && i.pr?.number === pr.number && sameSlug(i.pr.slug, pr.slug));

// A work item as a note names it: its worktree, else its PR, else its branch.
const workName = (i) =>
  i.worktree
    ? basename(i.worktree)
    : i.pr
      ? `${i.pr.slug}#${i.pr.number}`
      : i.branch;
