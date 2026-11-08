// Pull requests on GitHub (gh): their state and review threads, marking ready and
// merging.

import { firstLine, must, NOT_FOUND, tool } from "./lib.js";

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

// The fields prDetails reads, for a pullRequest in GitHub's GraphQL API.
const PR_FIELDS = `number url title state isDraft reviewDecision headRefName
  headRefOid mergeable autoMergeRequest { enabledAt }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
    nodes { ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } }
  reviewThreads(first: 100) { nodes { isResolved } }`;
const BY_NUMBER = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_FIELDS} } } }`;
// Like `gh pr view <branch>`: the open PR from that branch, else the latest.
const BY_BRANCH = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) { pullRequests(headRefName: $branch,
    first: 20, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } } } }`;

// Details for a PR (number or branch) in `slug`, or null when there is none,
// from one GraphQL call. Throws when GitHub can't be asked, so callers can
// tell "no PR" from "failed".
// `checks`: "passed" | "failed" | "pending", or null when the PR has none,
// with `checksPassed` of `checksTotal` passed (GitHub's "3/5")
// (CI not started, or never will: GitHub runs no pull_request CI on a PR that
// conflicts with its base). `mergeable`: "MERGEABLE" | "CONFLICTING" |
// "UNKNOWN" (GitHub works it out lazily, so it's UNKNOWN for a little while
// after a push or a change to the base). `unresolved`: the count of
// unresolved review threads on an open PR, else null.
/** @param {string} slug @param {string | number} ref @returns {Promise<import("./types.js").PR | null>} */
export async function prDetails(slug, ref) {
  const [owner, name] = slug.split("/");
  const byNumber = /^\d+$/.test(String(ref));
  const r = await tool("gh", [
    "api",
    "graphql",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    ...(byNumber ? ["-F", `number=${ref}`] : ["-f", `branch=${ref}`]),
    "-f",
    `query=${byNumber ? BY_NUMBER : BY_BRANCH}`,
  ]);
  if (r.code !== 0) {
    const why = firstLine(r.stderr) || firstLine(r.stdout);
    if (NOT_FOUND.test(why)) return null;
    throw new Error(why || `gh api graphql (PR ${ref} in ${slug}) failed`);
  }
  const repo = JSON.parse(r.stdout).data?.repository;
  const found = byNumber ? [repo?.pullRequest] : repo?.pullRequests?.nodes;
  const pr =
    found?.find((p) => p?.state === "OPEN") ?? found?.find(Boolean) ?? null;
  if (!pr) return null;
  const contexts =
    pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const results = contexts.map(
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
    checksPassed: results.filter((x) => OK.includes(x)).length,
    checksTotal: results.length,
    branch: pr.headRefName,
    head: pr.headRefOid,
    autoMerge: Boolean(pr.autoMergeRequest),
    mergeable: MERGE_STATES.includes(pr.mergeable) ? pr.mergeable : "UNKNOWN",
    unresolved:
      pr.state === "OPEN"
        ? (pr.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length
        : null,
  };
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
