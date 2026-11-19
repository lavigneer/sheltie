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

// The fields prDetails reads, for a pullRequest in GitHub's GraphQL API. A
// check's isRequired needs the PR's number, so it's only asked by number.
const prFields = (
  required,
) => `number url title body state isDraft reviewDecision headRefName
  headRefOid mergeable autoMergeRequest { enabledAt }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
    nodes { ... on CheckRun { status conclusion${required ? " isRequired(pullRequestNumber: $number)" : ""} }
      ... on StatusContext { state${required ? " isRequired(pullRequestNumber: $number)" : ""} } } } } } } }
  reviewThreads(first: 100) { nodes { isResolved } }`;
const byNumber = (
  required,
) => `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${prFields(required)} } } }`;
// Like `gh pr view <branch>`: the open PR from that branch, else the latest.
const BY_BRANCH = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) { pullRequests(headRefName: $branch,
    first: 20, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${prFields(false)} } } } }`;

// A PR's details from its pullRequest node in GitHub's GraphQL answer (see
// prFields), or null for none. Pure: no gh, no settings.
// `checks`: "passed" | "failed" | "pending", or null when the PR has none,
// with `checksPassed` of `checksTotal` passed (GitHub's "3/5")
// (CI not started, or never will: GitHub runs no pull_request CI on a PR that
// conflicts with its base). `mergeable`: "MERGEABLE" | "CONFLICTING" |
// "UNKNOWN" (GitHub works it out lazily, so it's UNKNOWN for a little while
// after a push or a change to the base). `settled`: the last mergeable GitHub
// had worked out, carried over from `previous` (this PR's last details) while
// it's UNKNOWN, so a conflict is told once, not again after every push that
// doesn't fix it. `unresolved`: the count of unresolved review threads on an
// open PR, else null. With `requiredOnly`, checks that aren't required for
// merging (no isRequired on the node) are left out of `checks` and its counts.
/** @param {string} slug @param {any} pr @param {import("./types.js").PR | null} [previous] @param {{ requiredOnly?: boolean }} [opts] @returns {import("./types.js").PR | null} */
export function parsePR(
  slug,
  pr,
  previous = null,
  { requiredOnly = false } = {},
) {
  if (!pr) return null;
  const contexts = (
    pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
  ).filter((c) => !requiredOnly || c.isRequired);
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
  const mergeable = MERGE_STATES.includes(pr.mergeable)
    ? pr.mergeable
    : "UNKNOWN";
  return {
    slug,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    body: pr.body ?? "",
    state: pr.state,
    draft: pr.isDraft,
    review: pr.reviewDecision || null,
    checks,
    checksPassed: results.filter((x) => OK.includes(x)).length,
    checksTotal: results.length,
    branch: pr.headRefName,
    head: pr.headRefOid,
    autoMerge: Boolean(pr.autoMergeRequest),
    mergeable,
    settled:
      mergeable === "UNKNOWN"
        ? previous?.number === pr.number
          ? (previous?.settled ?? null)
          : null
        : mergeable,
    unresolved:
      pr.state === "OPEN"
        ? (pr.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length
        : null,
  };
}

// The pullRequest node for a PR (number or branch) in `slug`, or null when
// there is none, from one GraphQL call (the open PR from a branch, else its
// latest). Throws when GitHub can't be asked, so callers can tell "no PR"
// from "failed". `required` asks each check's isRequired (by number only).
/** @param {string} slug @param {string | number} ref @param {boolean} required */
async function fetchPR(slug, ref, required) {
  const [owner, name] = slug.split("/");
  const isNumber = /^\d+$/.test(String(ref));
  const r = await tool("gh", [
    "api",
    "graphql",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    ...(isNumber ? ["-F", `number=${ref}`] : ["-f", `branch=${ref}`]),
    "-f",
    `query=${isNumber ? byNumber(required) : BY_BRANCH}`,
  ]);
  if (r.code !== 0) {
    const why = firstLine(r.stderr) || firstLine(r.stdout);
    if (NOT_FOUND.test(why)) return null;
    throw new Error(why || `gh api graphql (PR ${ref} in ${slug}) failed`);
  }
  const repo = JSON.parse(r.stdout).data?.repository;
  const found = isNumber ? [repo?.pullRequest] : repo?.pullRequests?.nodes;
  return (
    found?.find((p) => p?.state === "OPEN") ?? found?.find(Boolean) ?? null
  );
}

// Details for a PR (number or branch) in `slug` (see parsePR), or null when
// there is none; throws when GitHub can't be asked. With `requiredOnly`
// (the requiredChecksOnly setting), only checks required for merging count.
/** @param {string} slug @param {string | number} ref @param {import("./types.js").PR | null} [previous] @param {{ requiredOnly?: boolean }} [opts] @returns {Promise<import("./types.js").PR | null>} */
export async function prDetails(
  slug,
  ref,
  previous = null,
  { requiredOnly = false } = {},
) {
  let pr = await fetchPR(slug, ref, requiredOnly);
  // Found by branch: ask again by number, for which checks are required.
  if (pr && requiredOnly && !/^\d+$/.test(String(ref)))
    pr = await fetchPR(slug, pr.number, true);
  return parsePR(slug, pr, previous, { requiredOnly });
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

// --- Reviews ----------------------------------------------------------------

// The PRs a GitHub search (C.reviewSearch; by default those requesting your
// review, yourself or a team you're on) finds, with when each was last
// requested and your latest review, from one GraphQL search.
const REVIEW_SEARCH = `query($q: String!) { viewer { login }
  search(query: $q, type: ISSUE, first: 100) {
    nodes { ... on PullRequest { number url title additions deletions createdAt
      repository { nameWithOwner } author { login }
      timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) { nodes {
        ... on ReviewRequestedEvent { createdAt
          requestedReviewer { __typename ... on User { login } } } } }
      latestReviews(last: 100) { nodes { author { login } submittedAt } } } } } }`;

// The raw search for `search` (see reviewQueue), throwing when GitHub can't
// be asked.
/** @param {string} search */
export async function reviewRequests(search) {
  const out = await must(
    "gh",
    ["api", "graphql", "-f", `query=${REVIEW_SEARCH}`, "-f", `q=${search}`],
    "gh api graphql (review requests)",
  );
  return JSON.parse(out).data;
}

// The review queue from a reviewRequests() answer: PRs in the repos `slugs`
// (others are left out), oldest request first. A PR you've reviewed since its
// last request to you (or a team) drops off; a re-request brings it back.
// Each: { slug, number, url, title, author, requestedAt, additions, deletions }.
/** @param {any} data @param {string[]} slugs @returns {import("./types.js").Review[]} */
export function reviewQueue(data, slugs) {
  const me = data?.viewer?.login?.toLowerCase();
  const known = new Set(slugs.map((s) => s.toLowerCase()));
  return (data?.search?.nodes ?? [])
    .filter((pr) => known.has(pr?.repository?.nameWithOwner?.toLowerCase()))
    .map((pr) => {
      const asked = (pr.timelineItems?.nodes ?? [])
        .filter((e) => {
          const r = e?.requestedReviewer;
          return r?.__typename === "Team" || r?.login?.toLowerCase() === me;
        })
        .map((e) => e.createdAt)
        .sort();
      const reviewed = (pr.latestReviews?.nodes ?? [])
        .filter((r) => r?.author?.login?.toLowerCase() === me)
        .map((r) => r.submittedAt)
        .sort();
      return {
        slug: pr.repository.nameWithOwner,
        number: pr.number,
        url: pr.url,
        title: pr.title,
        author: pr.author?.login ?? "ghost",
        // No request event (e.g. a CODEOWNERS one on opening): since it opened.
        requestedAt: asked.at(-1) ?? pr.createdAt,
        reviewedAt: reviewed.at(-1) ?? null,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
      };
    })
    .filter((r) => !r.reviewedAt || r.reviewedAt < r.requestedAt)
    .map(({ reviewedAt: _, ...r }) => r)
    .sort(
      (a, b) =>
        a.requestedAt.localeCompare(b.requestedAt) ||
        a.slug.localeCompare(b.slug) ||
        a.number - b.number,
    );
}
