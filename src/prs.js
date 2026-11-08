// Pull requests on GitHub (gh): their state, review threads, marking ready and
// merging.

import { NOT_FOUND, firstLine, must, tool } from "./lib.js";

const OK = ["SUCCESS", "NEUTRAL", "SKIPPED", "COMPLETED"];
const BAD = [
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
];

const MERGE_STATES = ["MERGEABLE", "CONFLICTING"];

// Details for a PR (number or branch) in `slug`, or null when there is none.
// Throws when GitHub can't be asked, so callers can tell "no PR" from "failed".
// `checks`: "passed" | "failed" | "pending", or null when the PR has none
// (CI not started, or never will: GitHub runs no pull_request CI on a PR that
// conflicts with its base). `mergeable`: "MERGEABLE" | "CONFLICTING" |
// "UNKNOWN" (GitHub works it out lazily, so it's UNKNOWN for a little while
// after a push or a change to the base).
export async function prDetails(slug, ref) {
  const r = await tool("gh", [
    "pr",
    "view",
    String(ref),
    "--repo",
    slug,
    "--json",
    "number,url,title,state,isDraft,reviewDecision,statusCheckRollup,headRefName,headRefOid,autoMergeRequest,mergeable",
  ]);
  if (r.code !== 0) {
    const why = firstLine(r.stderr);
    if (NOT_FOUND.test(why)) return null;
    throw new Error(why || `gh pr view ${ref} --repo ${slug} failed`);
  }
  const pr = JSON.parse(r.stdout);
  const results = (pr.statusCheckRollup ?? []).map(
    (c) => c.conclusion || c.state || c.status || "",
  );
  // A result we don't recognise counts as still running, never as passed.
  const checks = !results.length
    ? null
    : results.some((x) => BAD.includes(x))
      ? "failed"
      : results.every((x) => OK.includes(x))
        ? "passed"
        : "pending";
  return {
    slug,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    draft: pr.isDraft,
    review: pr.reviewDecision || null,
    checks,
    branch: pr.headRefName,
    head: pr.headRefOid,
    autoMerge: Boolean(pr.autoMergeRequest),
    mergeable: MERGE_STATES.includes(pr.mergeable) ? pr.mergeable : "UNKNOWN",
  };
}

// Unresolved review threads on an open PR (a number).
export async function unresolvedThreads(slug, number) {
  const [owner, name] = slug.split("/");
  const out = await must(
    "gh",
    [
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${number}`,
      "-f",
      "query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { isResolved } } } } }",
      "--jq",
      "[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length",
    ],
    "gh api graphql",
  );
  return Number(out.trim());
}

export const markReady = (slug, number) =>
  must("gh", ["pr", "ready", String(number), "--repo", slug], "gh pr ready");

// The merge method GitHub's web UI offers you first for this repo.
const mergeMethods = new Map();
async function defaultMergeMethod(slug) {
  if (!mergeMethods.has(slug)) {
    const out = await must(
      "gh",
      [
        "repo",
        "view",
        slug,
        "--json",
        "viewerDefaultMergeMethod",
        "--jq",
        ".viewerDefaultMergeMethod",
      ],
      "gh repo view",
    );
    mergeMethods.set(slug, out.trim().toLowerCase() || "merge");
  }
  return mergeMethods.get(slug);
}

// Merges a PR now, or with `auto` once its requirements (reviews, checks) are
// met, using the web UI's default merge method.
export async function mergePr(slug, number, { auto = false } = {}) {
  const method = await defaultMergeMethod(slug);
  await must(
    "gh",
    [
      "pr",
      "merge",
      String(number),
      "--repo",
      slug,
      `--${method}`,
      ...(auto ? ["--auto"] : []),
    ],
    "gh pr merge",
  );
}

// "#881 draft approved ✓" (or "#881 draft conflicts") and a tone for
// coloring: "bad" | "good" | null.
export function prLabel(pr) {
  if (!pr) return null;
  const parts = [`#${pr.number}`];
  if (pr.state === "MERGED") parts.push("merged");
  else if (pr.state === "CLOSED") parts.push("closed");
  else {
    if (pr.draft) parts.push("draft");
    if (pr.review === "APPROVED") parts.push("approved");
    else if (pr.review === "CHANGES_REQUESTED") parts.push("changes requested");
    else if (!pr.draft && !pr.review) parts.push("no review needed");
    if (pr.checks)
      parts.push({ failed: "✗", pending: "◌", passed: "✓" }[pr.checks]);
  }
  const conflicts = pr.state === "OPEN" && pr.mergeable === "CONFLICTING";
  if (conflicts) parts.push("conflicts");
  const bad =
    conflicts || pr.checks === "failed" || pr.review === "CHANGES_REQUESTED";
  const good =
    pr.state === "MERGED" ||
    (pr.review === "APPROVED" && pr.checks === "passed");
  return { text: parts.join(" "), tone: bad ? "bad" : good ? "good" : null };
}

