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

/**
 * A check on a PR's head commit: a CheckRun (conclusion, status) or a
 * StatusContext (state). isRequired is set when GitHub asks for it.
 * @typedef {{ isRequired?: boolean, conclusion?: string | null, state?: string | null, status?: string | null }} CheckContext
 */
/**
 * A pullRequest node from prDetails' query (prFields), as parsePR reads it.
 * @typedef {{
 *   number: number, updatedAt?: string, url: string, title: string, body?: string | null,
 *   state: "OPEN" | "CLOSED" | "MERGED", isDraft: boolean, reviewDecision?: string | null,
 *   headRefName: string, baseRefName?: string | null, headRefOid: string,
 *   mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN", autoMergeRequest?: unknown, isInMergeQueue?: boolean,
 *   commits?: { nodes?: { commit?: { statusCheckRollup?: { contexts?: { nodes?: CheckContext[] } } | null } }[] },
 *   reviewThreads?: { nodes?: { isResolved: boolean }[] },
 * }} GqlPR
 */
/**
 * A PR node from reviewRequests()'s search, as reviewQueue reads it.
 * @typedef {{
 *   number: number, url: string, title: string, createdAt: string,
 *   additions?: number | null, deletions?: number | null,
 *   author?: { login: string } | null,
 *   repository: { nameWithOwner: string },
 *   timelineItems?: { nodes?: { createdAt: string, requestedReviewer?: { __typename?: string, login?: string } | null }[] },
 *   latestReviews?: { nodes?: { submittedAt: string, author?: { login?: string } | null }[] },
 * }} ReviewPR
 */
/** @typedef {{ viewer?: { login?: string } | null, search?: { nodes?: (ReviewPR | null)[] } }} ReviewsData */

// The fields prDetails reads, for a pullRequest in GitHub's GraphQL API. A
// check's isRequired needs the PR's number, so it's only asked by number.
/** @param {boolean} required @param {string | number} [number] */
const prFields = (
  required,
  number,
) => `number updatedAt url title body state isDraft reviewDecision headRefName baseRefName
  headRefOid mergeable autoMergeRequest { enabledAt } isInMergeQueue
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
    nodes { ... on CheckRun { status conclusion${required ? ` isRequired(pullRequestNumber: ${number})` : ""} }
      ... on StatusContext { state${required ? ` isRequired(pullRequestNumber: ${number})` : ""} } } } } } } }
  reviewThreads(first: 100) { nodes { isResolved } }`;

// What a probe asks for (probePRs): which PR a ref names, and when it last
// changed. Without prFields' connections it costs GitHub a fraction of a full
// lookup, so far more refs go in one query.
const PROBE_FIELDS = "number updatedAt state";

// PRs looked up per GraphQL query. Each lookup is an alias in it: p<i> for a
// PR by number, b<i> for a branch (its name in the variable $b<i>). GitHub
// rounds each query's cost up to at least 1 point, so a bigger batch spends
// fewer points. A full lookup asks for about 3 connections per PR (commits,
// check contexts, review threads), and a branch lookup takes up to 20 PRs, so
// 20 lookups stay well under GitHub's 500,000-node limit per query.
export const PRS_PER_QUERY = 20;
// Probes per GraphQL query (see probePRs).
export const PROBES_PER_QUERY = 100;
/** @param {unknown} ref */
const isNumber = (ref) => /^\d+$/.test(String(ref));

// The query for `lookups` ({ alias, ref, number, required }), asking for
// prFields, or for PROBE_FIELDS with `probe`. A number is only ever digits, so
// it goes in as a literal.
/** @param {any[]} lookups @param {boolean} [probe] */
function batchQuery(lookups, probe = false) {
  const vars = lookups
    .filter((l) => !l.number)
    .map((l) => `, $${l.alias}: String!`)
    .join("");
  const fields = lookups.map((l) =>
    l.number
      ? `${l.alias}: pullRequest(number: ${l.ref}) { ${probe ? PROBE_FIELDS : prFields(l.required, l.ref)} }`
      : // Like `gh pr view <branch>`: the open PR from that branch, else the latest.
        `${l.alias}: pullRequests(headRefName: $${l.alias}, first: 20, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${probe ? PROBE_FIELDS : prFields(false)} } }`,
  );
  return `query($owner: String!, $name: String!${vars}) {
  repository(owner: $owner, name: $name) { ${fields.join("\n    ")} } }`;
}

// Each lookup's pullRequest node (null for none), or an Error for one that
// failed, from one query's answer (`r`, the gh result). A query that failed as
// a whole fails each of its lookups; "not found" is none.
/** @param {any} r @param {any[]} lookups */
function answers(r, lookups) {
  let body = null;
  try {
    body = JSON.parse(r.stdout);
  } catch {}
  const out = new Map();
  if (!body?.data?.repository) {
    const why =
      firstLine(r.stderr) ||
      body?.errors?.[0]?.message ||
      "gh api graphql failed";
    for (const l of lookups)
      out.set(l.ref, NOT_FOUND.test(why) ? null : new Error(why));
    return out;
  }
  for (const l of lookups) {
    const err = body.errors?.find(
      (/** @type {any} */ e) =>
        e.path?.[1] === l.alias && !NOT_FOUND.test(e.message),
    );
    if (err) {
      out.set(l.ref, new Error(err.message));
      continue;
    }
    const v = body.data.repository[l.alias];
    out.set(
      l.ref,
      l.number
        ? (v ?? null)
        : ((v?.nodes ?? []).find(
            (/** @type {any} */ p) => p?.state === "OPEN",
          ) ??
            (v?.nodes ?? []).find(Boolean) ??
            null),
    );
  }
  return out;
}

// The PR nodes for `refs` ({ ref, required }, in `slug`), a query per
// PRS_PER_QUERY (PROBES_PER_QUERY with `probe`): Map ref -> node, null for
// none, or an Error. `urgent`: a click's lookup (lib.js limits).
/** @param {string} slug @param {{ ref: string | number, required: boolean }[]} refs @param {{ probe?: boolean, urgent?: boolean }} [opts] */
async function fetchPRs(slug, refs, { probe = false, urgent = false } = {}) {
  const [owner, name] = slug.split("/");
  const out = new Map();
  const chunks = [];
  const size = probe ? PROBES_PER_QUERY : PRS_PER_QUERY;
  for (let i = 0; i < refs.length; i += size)
    chunks.push(refs.slice(i, i + size));
  await Promise.all(
    chunks.map(async (chunk) => {
      const lookups = chunk.map((l, i) => {
        const number = isNumber(l.ref);
        return { ...l, number, alias: `${number ? "p" : "b"}${i}` };
      });
      const vars = lookups
        .filter((l) => !l.number)
        .flatMap((l) => ["-f", `${l.alias}=${l.ref}`]);
      const r = await tool(
        "gh",
        [
          "api",
          "graphql",
          "-F",
          `owner=${owner}`,
          "-F",
          `name=${name}`,
          ...vars,
          "-f",
          `query=${batchQuery(lookups, probe)}`,
        ],
        { urgent },
      );
      for (const [ref, node] of answers(r, lookups)) out.set(ref, node);
    }),
  );
  return out;
}

// The PR each of `refs` (numbers or branches, in `slug`) names now, as
// { number, updatedAt, state } (null for none, an Error for a failed lookup),
// to decide whether a PR needs a full lookup (WorkStore.refresh in work.js).
/** @param {string} slug @param {(string | number)[]} refs @returns {Promise<Map<string | number, { number: number, updatedAt: string, state: string } | null | Error>>} */
export function probePRs(slug, refs) {
  return fetchPRs(
    slug,
    refs.map((ref) => ({ ref, required: false })),
    { probe: true },
  );
}

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
/** @param {string} slug @param {GqlPR | null} pr @param {import("./types.js").PR | null} [previous] @param {{ requiredOnly?: boolean }} [opts] @returns {import("./types.js").PR | null} */
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
    updatedAt: pr.updatedAt ?? null,
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
    base: pr.baseRefName ?? null,
    head: pr.headRefOid,
    // GitHub merges it on its own: auto-merge on, or already in a merge queue.
    autoMerge: Boolean(pr.autoMergeRequest || pr.isInMergeQueue),
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
// Details for PRs in `slug`: `items` are { ref, previous } (see parsePR), a
// query per PRS_PER_QUERY of them. Map ref -> details, or null for none, or an
// Error for a lookup that failed (GitHub unreachable: retried later, never
// shown as none). With `requiredOnly` (the requiredChecksOnly setting), only
// checks required for merging count.
/** @param {string} slug @param {{ ref: string | number, previous?: import("./types.js").PR | null }[]} items @param {{ requiredOnly?: boolean, urgent?: boolean }} [opts] @returns {Promise<Map<string | number, import("./types.js").PR | null | Error>>} */
export async function prDetailsMany(
  slug,
  items,
  { requiredOnly = false, urgent = false } = {},
) {
  const found = await fetchPRs(
    slug,
    items.map(({ ref }) => ({
      ref,
      required: requiredOnly && isNumber(ref),
    })),
    { urgent },
  );
  // Found by branch: ask again by number, for which checks are required.
  if (requiredOnly) {
    const byBranch = items.filter(({ ref }) => {
      const pr = found.get(ref);
      return !isNumber(ref) && pr && !(pr instanceof Error);
    });
    const byNumber = await fetchPRs(
      slug,
      byBranch.map(({ ref }) => ({
        ref: found.get(ref).number,
        required: true,
      })),
      { urgent },
    );
    for (const { ref } of byBranch)
      found.set(ref, byNumber.get(found.get(ref).number));
  }
  return new Map(
    items.map(({ ref, previous = null }) => {
      const pr = found.get(ref) ?? null;
      return [
        ref,
        pr instanceof Error
          ? pr
          : parsePR(slug, pr, previous, { requiredOnly }),
      ];
    }),
  );
}

// Details for a PR (number or branch) in `slug` (see parsePR), or null when
// there is none; throws when GitHub can't be asked.
/** @param {string} slug @param {string | number} ref @param {import("./types.js").PR | null} [previous] @param {{ requiredOnly?: boolean, urgent?: boolean }} [opts] @returns {Promise<import("./types.js").PR | null>} */
export async function prDetails(slug, ref, previous = null, opts = {}) {
  const pr = (await prDetailsMany(slug, [{ ref, previous }], opts)).get(ref);
  if (pr instanceof Error) throw pr;
  return pr ?? null;
}

// Ready and Merge are clicks (flow.js), so their gh calls are urgent (lib.js).
export const markReady = (
  /** @type {string} */ slug,
  /** @type {number} */ number,
) =>
  must("gh", ["pr", "ready", String(number), "--repo", slug], "gh pr ready", {
    urgent: true,
  });

// The merge method GitHub's web UI offers you first for this repo.
const mergeMethods = new Map();
/** @param {string} slug */
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
      { urgent: true },
    );
    mergeMethods.set(slug, out.trim().toLowerCase() || "merge");
  }
  return mergeMethods.get(slug);
}

// Merges a PR now, or with `auto` once its requirements (reviews, checks) are
// met, using the web UI's default merge method.
/** @param {string} slug @param {number} number @param {{ auto?: boolean }} [opts] */
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
    { urgent: true },
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
/** @param {ReviewsData} data @param {string[]} slugs @returns {import("./types.js").Review[]} */
export function reviewQueue(data, slugs) {
  const me = data?.viewer?.login?.toLowerCase();
  const known = new Set(slugs.map((s) => s.toLowerCase()));
  return /** @type {ReviewPR[]} */ (data?.search?.nodes ?? [])
    .filter((pr) =>
      known.has(
        /** @type {string} */ (pr?.repository?.nameWithOwner?.toLowerCase()),
      ),
    )
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
    .map((x) => {
      const { reviewedAt: _, ...r } = x;
      return r;
    })
    .sort(
      (a, b) =>
        a.requestedAt.localeCompare(b.requestedAt) ||
        a.slug.localeCompare(b.slug) ||
        a.number - b.number,
    );
}
