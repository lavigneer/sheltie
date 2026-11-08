// Jira (Cloud or Server/Data Center) through jira-cli. Keys look like WEB-142
// and are their own branch part. Settings: C.jira.

import { C } from "./config.js";
import { NOT_FOUND, firstLine, must, pool, tool } from "./lib.js";

export const name = "jira";

const ticketOf = (i) => ({
  key: i.key,
  label: i.key,
  ref: i.key,
  summary: i.fields?.summary ?? "",
  status: i.fields?.status?.name ?? "",
  components: (i.fields?.components ?? []).map((c) => c.name),
  labels: i.fields?.labels ?? [],
  project: i.key.split("-")[0],
  repo: null,
});

export async function list() {
  const out = await must(
    "jira",
    [
      "issue",
      "list",
      "--raw",
      "--jql",
      C.jira.jql,
      "--order-by",
      "updated",
      "--paginate",
      "0:100",
    ],
    "jira issue list",
  );
  return JSON.parse(out || "[]").map(ticketOf);
}

export async function view(key) {
  const r = await tool("jira", ["issue", "view", key, "--raw"]);
  if (r.code !== 0) {
    const why = firstLine(r.stderr) || firstLine(r.stdout);
    if (NOT_FOUND.test(why)) return null;
    throw new Error(why || `jira issue view ${key} failed`);
  }
  return ticketOf(JSON.parse(r.stdout));
}

// Moves the ticket for workflow step "start" | "review" | "done" (the
// transitions in C.jira), unless it's already in that state. Returns a note,
// or null when there's nothing to do.
export async function move(key, step, status = null) {
  const to = C.jira.transitions?.[step];
  if (!to || status === to) return null;
  const resolution = step === "done" ? C.jira.resolution : null;
  const r = await tool("jira", [
    "issue",
    "move",
    key,
    to,
    ...(resolution ? ["--resolution", resolution] : []),
  ]);
  if (r.code !== 0)
    throw new Error(
      `${key} → ${to}: ${firstLine(r.stderr) || firstLine(r.stdout) || "jira issue move failed"}`,
    );
  return `${key} → ${to}`;
}

export async function url(key) {
  const r = await tool("jira", ["open", key, "--no-browser"]).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() || null : null;
}

export const viewCommand = (key) => `jira issue view ${key} --plain --comments 20`;
export const labelOf = (key) => key;

// Jira keys in a branch name or PR text: "me/WEB-142-fix" -> ["WEB-142"].
export const keysIn = (text) => [
  ...new Set((text || "").toUpperCase().match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? []),
];

// The orgs/users to search for PRs: C.githubOwners plus owners of known repos.
function owners(repos) {
  const all = new Set(C.githubOwners);
  for (const r of repos) if (r.slug) all.add(r.slug.split("/")[0]);
  for (const rule of C.repoRules)
    if (/^[^/~][^/]*\/[^/]+$/.test(rule.repo ?? ""))
      all.add(rule.repo.split("/")[0]);
  return [...all];
}

// PRs that mention each key (title or body), across those owners:
// Map key -> [{ slug, number }].
export async function linkedPRs(keys, repos) {
  const out = new Map(keys.map((k) => [k, []]));
  const who = owners(repos);
  if (!keys.length || !who.length) return out;
  const chunks = [];
  for (let i = 0; i < keys.length; i += 6) chunks.push(keys.slice(i, i + 6));
  const found = await pool(
    chunks.map((chunk) => async () => {
      const args = [
        "search",
        "prs",
        chunk.map((k) => `"${k}"`).join(" OR "),
        "--limit",
        "100",
        "--json",
        "number,title,body,repository",
      ];
      for (const o of who) args.push("--owner", o);
      return JSON.parse(await must("gh", args, "gh search prs"));
    }),
    2,
  );
  for (const p of found.flat().filter(Boolean)) {
    const mentioned = keysIn(`${p.title}\n${p.body ?? ""}`);
    for (const k of keys)
      if (mentioned.includes(k))
        out.get(k).push({ slug: p.repository?.nameWithOwner, number: p.number });
  }
  return out;
}

// Jira has no repo of its own: repoRules decide.
export const suggest = () => [];
