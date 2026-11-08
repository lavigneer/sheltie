// The ticket workflow after the worktree exists, for the Work sidebar:
//
//   no PR ─► draft (CI …/✗/✓, comments) ─► ready ─► approved ─► merged ─► finished
//
// A worktree's stage is derived from its pull request every time (nothing is
// stored), and each stage offers its next steps:
//   Draft PR / Fix CI / Address comments   sent to the space's agent
//                                          (C.agent.steps: /draft-pr, /fix-ci,
//                                          /address-comments by default)
//   Ready     gh pr ready; with C.workflow.autoMerge "when-reviews-required",
//             auto-merge while reviews are still required, so it merges on
//             approval and never at once; tracker step "review"
//   Merge     when approved and green but auto-merge is off
//   Finish    after the merge: close its space, remove the worktree and local
//             branch (refused if anything isn't in the PR), tracker step "done"
//             unless other work on the ticket is still open

import { agents, panes, run, spaces, terminals } from "herdr";
import { C } from "./config.js";
import {
  assertClean,
  markReady,
  mergePr,
  prDetails,
  removeWorktree,
} from "./data.js";
import { basename, inside, spaceFor, tool } from "./lib.js";
import { tracker } from "./tracker.js";

const AGENT_STEPS = ["draft-pr", "fix-ci", "address-comments"];

// --- Stage ------------------------------------------------------------------

// pr: prDetails() plus `unresolved` (a count, or null when unknown).
export function stageOf(pr) {
  if (!pr) return "no-pr";
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (pr.draft) return "draft";
  return pr.review === "APPROVED" ? "approved" : "in-review";
}

// The next steps for a worktree: [{ id, label, kind: "agent" | "direct", confirm }].
// `working`: its agent is busy, so nothing is sent to it.
export function nextSteps(pr, { working = false } = {}) {
  const stage = stageOf(pr);
  const steps = [];
  const agent = (id, label) => {
    if (!working && C.agent.steps?.[id])
      steps.push({ id, label, kind: "agent" });
  };
  const green = pr && pr.checks !== "failed" && pr.checks !== "pending";
  if (stage === "no-pr") agent("draft-pr", "Draft PR");
  if (["draft", "in-review", "approved"].includes(stage)) {
    if (pr.checks === "failed") agent("fix-ci", "Fix CI");
    if (pr.unresolved > 0)
      agent(
        "address-comments",
        `Address ${pr.unresolved} comment${pr.unresolved === 1 ? "" : "s"}`,
      );
    else if (pr.review === "CHANGES_REQUESTED")
      agent("address-comments", "Address review");
  }
  if (stage === "draft" && green && !pr.unresolved)
    steps.push({ id: "ready", label: "Ready", kind: "direct" });
  if (stage === "approved" && green && !pr.autoMerge)
    steps.push({ id: "merge", label: "Merge", kind: "direct" });
  const confirm = C.workflow.confirmFinish !== false;
  if (stage === "merged")
    steps.push({ id: "finish", label: "Finish", kind: "direct", confirm });
  if (stage === "closed")
    steps.push({ id: "clean-up", label: "Clean up", kind: "direct", confirm });
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
  return here.find((p) => labelled.has(p.terminal))?.terminal ?? null;
}

// Sends a step's message to the worktree's agent, or starts one with it.
async function tellAgent(w, id) {
  const text = C.agent.steps[id];
  const space = spaceFor(w.path);
  const address = agentIn(space);
  if (address) {
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
      name: w.key ? tracker().labelOf(w.key) : basename(w.path),
      folder: w.path,
      argv: C.agent.argv,
      task: text,
    });
  return `sent ${text.split("\n")[0]}`;
}

// --- Steps ------------------------------------------------------------------

// Runs step `id` for worktree `w` ({ path, branch, key, repo }) whose PR is
// `pr`. `others`: the other worktrees with their PRs ([{ w, pr }]), to tell
// whether the ticket still has open work. Returns a short note, or throws.
export async function runStep(id, w, pr, others = []) {
  if (AGENT_STEPS.includes(id)) return tellAgent(w, id);
  if (id === "ready") {
    await markReady(w.repo.slug, pr.number);
    const notes = ["ready for review"];
    // Auto-merge only waits for what the repo requires; without required
    // reviews it would merge at once, so then leave merging to the Merge step.
    if (C.workflow.autoMerge === "when-reviews-required") {
      const now = await prDetails(w.repo.slug, pr.number);
      if (
        now?.review === "REVIEW_REQUIRED" ||
        now?.review === "CHANGES_REQUESTED"
      ) {
        await mergePr(w.repo.slug, pr.number, { auto: true });
        notes.push("auto-merge on approval");
      }
    }
    if (w.key) {
      const moved = await tracker().move(w.key, "review");
      if (moved) notes.push(moved);
    }
    return notes.join(" · ");
  }
  if (id === "merge") {
    await mergePr(w.repo.slug, pr.number);
    return "merged";
  }
  if (id === "finish" || id === "clean-up") {
    await assertClean(w.path, pr?.head ?? null);
    // Its spaces end with it (the agent's work is in the PR by now).
    for (const s of spaces())
      if (!s.machine && s.folder && inside(s.folder, w.path))
        run("space.close", { id: s.id, confirmed: true });
    await removeWorktree(w.repo, w.path, w.branch, pr?.head ?? null);
    const notes = ["worktree removed"];
    if (id === "finish" && w.key) {
      const open = others.filter(
        (o) =>
          o.w.key === w.key && !["merged", "closed"].includes(stageOf(o.pr)),
      );
      if (open.length)
        notes.push(
          `${tracker().labelOf(w.key)} left open: ${open.map((o) => basename(o.w.path)).join(", ")} still in progress`,
        );
      else {
        const moved = await tracker().move(w.key, "done");
        if (moved) notes.push(moved);
      }
    }
    return notes.join(" · ");
  }
  throw new Error(`unknown step ${id}`);
}
