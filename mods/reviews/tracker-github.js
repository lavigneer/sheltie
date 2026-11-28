// GitHub issues through gh. A key is "owner/repo#12" (lowercase owner/repo);
// its branch part comes from C.github.ref ("issue-{number}" by default) and
// new work goes to the issue's own repo unless repoRules say otherwise.

import { fill, firstLine, must, NOT_FOUND, pool, tool } from "./lib.js";

// Issues asked about in one GraphQL query (linkedPRs).
export const ISSUES_PER_QUERY = 50;

// A tracker using settings `s` (the global ones, or a repo's: config.js).
/** @param {import("./config.js").Settings} s @returns {import("./types.js").Tracker} */
export function create(s) {
  const name = "github";

  /** @param {string} key */
  const parse = (key) => {
    const m = /^(.+)#(\d+)$/.exec(key);
    return m ? { slug: m[1], number: Number(m[2]) } : null;
  };

  /** @param {string} slug @param {string | number} number */
  const keyOf = (slug, number) => `${slug.toLowerCase()}#${number}`;
  // "#12" when s.github.repos names one repo, else "repo#12" (issue numbers
  // repeat across repos).
  /** @param {string} key */
  function labelOf(key) {
    const k = parse(key);
    if (!k) return key;
    return s.github.repos.length === 1
      ? `#${k.number}`
      : `${k.slug.split("/").pop()}#${k.number}`;
  }
  /** @param {number} number */
  const refOf = (number) => fill(s.github.ref, { number: String(number) });

  /** @param {any} i @param {string | null} [slug] */
  const ticketOf = (i, slug) => {
    const repo = slug ?? i.repository?.nameWithOwner;
    return {
      key: keyOf(repo, i.number),
      label: labelOf(keyOf(repo, i.number)),
      ref: refOf(i.number),
      summary: i.title ?? "",
      status: (i.state ?? "").toUpperCase() === "OPEN" ? "Open" : "Closed",
      components: [],
      labels: (i.labels ?? []).map((/** @type {any} */ l) => l.name),
      project: repo.toLowerCase(),
      repo,
    };
  };

  async function list() {
    const args = ["search", "issues"];
    if (s.github.search) args.push(s.github.search);
    args.push("--state", "open");
    if (s.github.assignee) args.push("--assignee", s.github.assignee);
    for (const r of s.github.repos) args.push("--repo", r);
    args.push(
      "--sort",
      "updated",
      "--limit",
      "100",
      "--json",
      "number,title,state,labels,repository",
    );
    return JSON.parse(await must("gh", args, "gh search issues")).map(
      (/** @type {any} */ i) => ticketOf(i),
    );
  }

  /** @param {string} key @param {boolean} [urgent] */
  async function view(key, urgent = false) {
    const k = parse(key);
    if (!k) return null;
    const r = await tool(
      "gh",
      [
        "issue",
        "view",
        String(k.number),
        "--repo",
        k.slug,
        "--json",
        "number,title,state,labels",
      ],
      { urgent },
    );
    if (r.code !== 0) {
      const why = firstLine(r.stderr);
      if (NOT_FOUND.test(why)) return null;
      throw new Error(why || `gh issue view ${key} failed`);
    }
    return ticketOf(JSON.parse(r.stdout), k.slug);
  }

  // Only "done" does anything: close the issue if it's still open (merging a PR
  // that says "Closes #12" usually did already) and s.github.closeOnFinish.
  // Reached only from a click's step, so its calls are urgent (lib.js).
  /** @param {string} key @param {string} step */
  async function move(key, step) {
    if (step !== "done" || !s.github.closeOnFinish) return null;
    const k = parse(key);
    const t = await view(key, true);
    if (!k || !t || t.status !== "Open") return null;
    await must(
      "gh",
      [
        "issue",
        "close",
        String(k.number),
        "--repo",
        k.slug,
        "--reason",
        "completed",
      ],
      "gh issue close",
      { urgent: true },
    );
    return `${labelOf(key)} closed`;
  }

  /** @param {string} key */
  const url = async (key) => {
    const k = parse(key);
    return k ? `https://github.com/${k.slug}/issues/${k.number}` : null;
  };

  /** @param {string} key */
  const viewCommand = (key) => {
    const k = parse(key);
    return k ? `gh issue view ${k.number} --repo ${k.slug} --comments` : key;
  };

  /** @param {string} s */
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Issues a branch name or PR text in repo `slug` mentions: the branch part
  // (s.github.ref), "#12" and "owner/repo#12".
  /** @param {string | null | undefined} text @param {string | null} [slug] */
  function keysIn(text, slug = null) {
    const t = text || "";
    const out = new Set();
    const [before, after] = s.github.ref.split("{number}").map(escapeRe);
    const ref = new RegExp(
      `(?:^|[^A-Za-z0-9])${before}(\\d+)${after ?? ""}(?![0-9])`,
      "gi",
    );
    if (slug) {
      for (const m of t.matchAll(ref)) out.add(keyOf(slug, m[1]));
      for (const m of t.matchAll(/(?:^|[\s(])#(\d+)\b/g))
        out.add(keyOf(slug, m[1]));
    }
    for (const m of t.matchAll(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g))
      out.add(keyOf(m[1], m[2]));
    return [...out];
  }

  // PRs GitHub links to each issue (that close it): Map key -> [{ slug, number }].
  // One GraphQL query per repo for up to ISSUES_PER_QUERY issues (an alias
  // each), not a gh call per issue (#366: 2,000 issues were 2,000 calls). A
  // failed query, or an issue that isn't there, gives no PRs.
  /** @param {string[]} keys */
  async function linkedPRs(keys) {
    /** @type {Map<string, { slug: string, number: number }[]>} */
    const out = new Map(keys.map((k) => [k, []]));
    /** @type {Map<string, { key: string, number: number }[]>} */
    const bySlug = new Map();
    for (const key of keys) {
      const k = parse(key);
      if (k)
        bySlug.set(k.slug, [
          ...(bySlug.get(k.slug) ?? []),
          { key, number: k.number },
        ]);
    }
    /** @type {(() => Promise<void>)[]} */
    const tasks = [];
    for (const [slug, issues] of bySlug)
      for (let at = 0; at < issues.length; at += ISSUES_PER_QUERY) {
        const chunk = issues.slice(at, at + ISSUES_PER_QUERY);
        tasks.push(async () => {
          const [owner, repo] = slug.split("/");
          const fields = chunk.map(
            (c, i) =>
              `i${i}: issue(number: ${c.number}) { closedByPullRequestsReferences(first: 20) { nodes { url } } }`,
          );
          const r = await tool("gh", [
            "api",
            "graphql",
            "-F",
            `owner=${owner}`,
            "-F",
            `name=${repo}`,
            "-f",
            `query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`,
          ]);
          /** @type {any} */
          let body = null;
          try {
            body = JSON.parse(r.stdout);
          } catch {}
          const answers = body?.data?.repository ?? {};
          chunk.forEach((c, i) => {
            for (const p of answers[`i${i}`]?.closedByPullRequestsReferences
              ?.nodes ?? []) {
              const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(
                p?.url ?? "",
              );
              if (m) out.get(c.key)?.push({ slug: m[1], number: Number(m[2]) });
            }
          });
        });
      }
    await pool(tasks);
    return out;
  }

  /** @param {{ repo: string | null }} ticket */
  const suggest = (ticket) =>
    ticket.repo ? [{ target: ticket.repo, why: "issue's repo" }] : [];

  return {
    name,
    labelOf,
    list,
    view,
    move,
    url,
    viewCommand,
    keysIn,
    linkedPRs,
    suggest,
  };
}
