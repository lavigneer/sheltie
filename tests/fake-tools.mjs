// Fake programs and a sandbox for driving mods end to end without the
// network: an app home with sheltie.json, a fake `gh` answering from a state
// file (issues and PRs, which a test may change), a fake `xdg-open` that only
// logs, and real git repos to scan. Call sandbox() before anything loads the
// settings (config.js reads them once per process).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `gh`: logs each call as a JSON line to calls.log and answers from
// state.json: { issues: { "<n>": { title, state } }, prs: { "<branch>": node } }
// where node is a GraphQL pullRequest node (see prFields in prs.js).
const GH = `#!/usr/bin/env node
const fs = require("node:fs");
const dir = ${"__DIR__"};
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.log", JSON.stringify(args) + "\\n");
const st = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
const arg = (p) => args.map((a) => a.match(p)).find(Boolean)?.[1];
const out = (v) => process.stdout.write(JSON.stringify(v));
if (args[0] === "api" && args[1] === "graphql") {
  const branch = arg(/^branch=(.*)$/s), number = arg(/^number=(\\d+)$/);
  const prs = Object.values(st.prs ?? {});
  if (branch !== undefined)
    out({ data: { repository: { pullRequests: { nodes: st.prs?.[branch] ? [st.prs[branch]] : [] } } } });
  else out({ data: { repository: { pullRequest: prs.find((p) => String(p.number) === number) ?? null } } });
} else if (args[0] === "issue" && args[1] === "view") {
  const i = st.issues?.[args[2]];
  if (!i) { process.stderr.write("GraphQL: Could not resolve to an issue\\n"); process.exit(1); }
  if (args.includes("closedByPullRequestsReferences")) out({ closedByPullRequestsReferences: [] });
  else out({ number: Number(args[2]), title: i.title, state: i.state ?? "OPEN", labels: [] });
}
`;

export function sandbox({ settings = {}, state = {} } = {}) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "sheltie-mod-")),
  );
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  const root = path.join(dir, "src");
  for (const d of [bin, home, root]) fs.mkdirSync(d);
  const gh = path.join(bin, "gh");
  fs.writeFileSync(gh, GH.replace("__DIR__", JSON.stringify(dir)));
  const open = path.join(bin, "xdg-open");
  fs.writeFileSync(
    open,
    `#!/bin/sh\necho "$1" >> ${JSON.stringify(path.join(dir, "opened.log"))}\n`,
  );
  fs.chmodSync(gh, 0o755);
  fs.chmodSync(open, 0o755);
  const setState = (s) =>
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(s));
  setState(state);
  const git = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  fs.writeFileSync(
    path.join(home, "sheltie.json"),
    JSON.stringify({
      roots: [root],
      depth: 1,
      tracker: "github",
      programs: { git, gh },
      usage: { agents: [] },
      ...settings,
    }),
  );
  process.env.HERDR_APP_HOME = home;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const lines = (f) =>
    fs.existsSync(path.join(dir, f))
      ? fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean)
      : [];
  return {
    dir,
    root,
    home,
    setState,
    // Each gh call's arguments.
    ghCalls: () => lines("calls.log").map((l) => JSON.parse(l)),
    // URLs opened in the browser.
    opened: () => lines("opened.log"),
  };
}

// A repo `name` under `root` with one commit on main, origin `slug` and a
// worktree under .worktrees/ for each of `branches`. Returns
// { path, worktree(branch) }.
export function gitRepo(root, name, slug, branches = []) {
  const repo = path.join(root, name);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
  fs.mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "-q", "--allow-empty", "-m", "start");
  git("remote", "add", "origin", `git@github.com:${slug}.git`);
  const worktree = (b) => path.join(repo, ".worktrees", b.replaceAll("/", "-"));
  for (const b of branches) git("worktree", "add", "-q", "-b", b, worktree(b));
  return { path: repo, git, worktree };
}

// A GraphQL pullRequest node for fake gh's state (see parsePR in prs.js).
export const prNode = (number, branch, over = {}) => ({
  number,
  url: `https://github.com/me/app/pull/${number}`,
  title: `PR ${number}`,
  body: "",
  state: "OPEN",
  isDraft: true,
  reviewDecision: null,
  headRefName: branch,
  headRefOid: "0".repeat(40),
  mergeable: "MERGEABLE",
  autoMergeRequest: null,
  commits: { nodes: [] },
  reviewThreads: { nodes: [] },
  ...over,
});
