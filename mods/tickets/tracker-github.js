// GitHub issues through gh. A key is "owner/repo#12" (lowercase owner/repo);
// its branch part comes from C.github.ref ("issue-{number}" by default) and
// new work goes to the issue's own repo unless repoRules say otherwise.

import { NOT_FOUND, fill, firstLine, must, pool, tool } from "./lib.js";

// A tracker using settings `s` (the global ones, or a repo's: config.js).
/** @param {import("./config.js").Settings} s @returns {import("./types.js").Tracker} */
export function create(s) {
  const name = "github";

  const parse = (key) => {
    const m = /^(.+)#(\d+)$/.exec(key);
    return m ? { slug: m[1], number: Number(m[2]) } : null;
  };

  const keyOf = (slug, number) => `${slug.toLowerCase()}#${number}`;
  // "#12" when s.github.repos names one repo, else "repo#12" (issue numbers
  // repeat across repos).
  function labelOf(key) {
    const k = parse(key);
    if (!k) return key;
    return s.github.repos.length === 1
      ? `#${k.number}`
      : `${k.slug.split("/").pop()}#${k.number}`;
  }
  const refOf = (number) => fill(s.github.ref, { number });

  const ticketOf = (i, slug) => {
    const repo = slug ?? i.repository?.nameWithOwner;
    return {
      key: keyOf(repo, i.number),
      label: labelOf(keyOf(repo, i.number)),
      ref: refOf(i.number),
      summary: i.title ?? "",
      status: (i.state ?? "").toUpperCase() === "OPEN" ? "Open" : "Closed",
      components: [],
      labels: (i.labels ?? []).map((l) => l.name),
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
    return JSON.parse(await must("gh", args, "gh search issues")).map((i) =>
      ticketOf(i),
    );
  }

  async function view(key) {
    const k = parse(key);
    if (!k) return null;
    const r = await tool("gh", [
      "issue",
      "view",
      String(k.number),
      "--repo",
      k.slug,
      "--json",
      "number,title,state,labels",
    ]);
    if (r.code !== 0) {
      const why = firstLine(r.stderr);
      if (NOT_FOUND.test(why)) return null;
      throw new Error(why || `gh issue view ${key} failed`);
    }
    return ticketOf(JSON.parse(r.stdout), k.slug);
  }

  // Only "done" does anything: close the issue if it's still open (merging a PR
  // that says "Closes #12" usually did already) and s.github.closeOnFinish.
  async function move(key, step) {
    if (step !== "done" || !s.github.closeOnFinish) return null;
    const k = parse(key);
    const t = await view(key);
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
    );
    return `${labelOf(key)} closed`;
  }

  const url = async (key) => {
    const k = parse(key);
    return k ? `https://github.com/${k.slug}/issues/${k.number}` : null;
  };

  const viewCommand = (key) => {
    const k = parse(key);
    return k ? `gh issue view ${k.number} --repo ${k.slug} --comments` : key;
  };

  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Issues a branch name or PR text in repo `slug` mentions: the branch part
  // (s.github.ref), "#12" and "owner/repo#12".
  function keysIn(text, slug = null) {
    const t = text || "";
    const out = new Set();
    const [before, after] = s.github.ref.split("{number}").map(escape);
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
  async function linkedPRs(keys) {
    const out = new Map(keys.map((k) => [k, []]));
    const found = await pool(
      keys.map((key) => async () => {
        const k = parse(key);
        if (!k) return null;
        const json = await must(
          "gh",
          [
            "issue",
            "view",
            String(k.number),
            "--repo",
            k.slug,
            "--json",
            "closedByPullRequestsReferences",
          ],
          "gh issue view",
        );
        return {
          key,
          prs: JSON.parse(json).closedByPullRequestsReferences ?? [],
        };
      }),
    );
    for (const f of found.filter(Boolean))
      for (const p of f.prs) {
        const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(p.url ?? "");
        if (m) out.get(f.key).push({ slug: m[1], number: Number(m[2]) });
      }
    return out;
  }

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
