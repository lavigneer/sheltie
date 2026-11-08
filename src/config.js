// Settings: <Herdr app home>/sheltie.json, merged over the defaults below.
// Every mod awaits configReady() before using them; `C` holds the result.
// See config.example.json for what each setting does.

import { appHome, exec, home } from "herdr";

export const DEFAULTS = {
  // Where your git repos are: folders `depth` levels below each root.
  roots: ["~/workspace"],
  depth: 1,

  // Programs, found on your login shell's PATH unless given as absolute paths.
  programs: { git: "git", gh: "gh", jira: "jira", hc: "hc" },

  // Where tickets come from: "jira" (jira-cli) or "github" (GitHub issues, gh).
  tracker: "jira",
  jira: {
    // Which tickets to list (jira-cli adds the ORDER BY). Naming `project`
    // makes jira-cli search every project, not just its default one.
    jql: "project IS NOT EMPTY AND assignee = currentUser() AND resolution = Unresolved",
    // Jira transitions at each step, or null for none.
    transitions: { start: null, review: null, done: "Resolved" },
    // Resolution set with the `done` transition, if its screen asks for one.
    resolution: null,
  },
  github: {
    // Which issues to list: open ones assigned to `assignee` ("@me": you),
    // in `repos` (owner/repo) or, if empty, anywhere you can see.
    repos: [],
    assignee: "@me",
    // Extra GitHub search terms, e.g. "label:bug" (optional).
    search: "",
    // The issue's part of a branch name; {number} is the issue number.
    ref: "issue-{number}",
    // Close the issue at Finish if merging its PR didn't already.
    closeOnFinish: true,
  },

  // GitHub orgs/users searched for pull requests that mention a ticket, in
  // addition to the owners of your local repos and of the repos in repoRules.
  githubOwners: [],

  // Where new work on a ticket goes. Each rule matches a ticket by any of
  // `component`, `label` or `project` (the Jira project key, or the issue's
  // owner/repo) and names a `repo`: "owner/repo" on GitHub (cloned into the
  // first root if needed) or a local path. Component and label rules win over
  // project rules.
  repoRules: [],

  // A ticket's branch: {ref} is the tracker's part (WEB-142, issue-12).
  branch: "{ref}",
  // Where ticket worktrees go, relative to the repo's main checkout.
  worktreeDir: ".worktrees",

  agent: {
    // The agent started in a ticket's space; its first message is the last
    // argument (as with `claude "<task>"`).
    argv: ["claude"],
    // First message for new work. {key}, {summary}, {url}, {branch} and
    // {viewCommand} (how to read the ticket) are filled in.
    // Both say how to tell the Work sidebar the PR is done (see
    // workflow.readyWhen).
    task: "Work on {key}: {summary}\n\nRun `{viewCommand}` for the description and comments. When the pull request is complete, run `hc label \"$HC_TERMINAL_ID\" pr=ready`.",
    // First message when asking for another branch of a ticket in a repo
    // that already has one: the agent names and creates it itself.
    extraBranchTask:
      "Start another piece of work for {key}: {summary}\n\nCreate a git worktree under {worktreeDir}/ in this repo on a new branch named {branch}-<short-description> (pick a short kebab-case description of the change), then work in it. Run `{viewCommand}` for the description and comments. When the pull request is complete, run `hc label \"$HC_TERMINAL_ID\" pr=ready`.",
    // What each Work sidebar step sends to the agent.
    steps: {
      "draft-pr": "/draft-pr",
      "fix-ci": "/fix-ci",
      "address-comments": "/address-comments",
      "resolve-conflicts": "/resolve-conflicts",
    },
  },

  workflow: {
    // At Ready: turn on auto-merge "when-reviews-required" (it then merges
    // on approval and never at once), or "never" (merge with the Merge step).
    autoMerge: "when-reviews-required",
    // When a draft PR is offered Ready: "green" (CI passed, no conflicts with
    // its base and nothing unresolved; a PR with no checks isn't green), or
    // "agent" (also only once its agent says the PR is done, by labelling
    // its terminal: `hc label "$HC_TERMINAL_ID" pr=ready`; the
    // label is cleared whenever a step is sent to the agent). Use "agent"
    // with agents that know this (the skills in skills/ do).
    readyWhen: "green",
    // Offer Merge for a ready, green PR that needs no review (a repo without
    // required reviews), not only for an approved one; false: merge those in
    // the browser.
    mergeWithoutReview: true,
    // Merge asks for a second click.
    confirmMerge: true,
    // Finish and Clean up ask for a second click.
    confirmFinish: true,
  },
};

export const SETTINGS_FILE = "sheltie.json";

// The settings in use. Filled in by configReady(); tests may set them with
// useConfig().
export const C = JSON.parse(JSON.stringify(DEFAULTS));

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

// `over` merged into `base`: objects key by key, everything else replaced.
export function merge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

let loading = null;

// Loads the settings once (later calls wait for the same load). A missing file
// means defaults; an unreadable or invalid one also means defaults, and
// `C.problem` says why, for the mods to show.
export function configReady() {
  loading ??= load();
  return loading;
}

async function load() {
  const path = `${appHome()}/${SETTINGS_FILE}`;
  let over = {};
  let problem = null;
  const r = await exec("cat", [path]).catch((e) => ({ code: 1, stderr: `${e}` }));
  if (r.code === 0) {
    try {
      over = JSON.parse(r.stdout);
      if (!isObject(over)) throw new Error("not a JSON object");
    } catch (e) {
      problem = `${path}: ${e.message ?? e}; using the defaults`;
      over = {};
    }
  } else if (!/no such file/i.test(r.stderr ?? "")) {
    problem = `couldn't read ${path}: ${(r.stderr ?? "").trim()}`;
  }
  const settings = merge(DEFAULTS, over);
  settings.programs = await resolvePrograms(settings.programs);
  useConfig(settings, problem);
}

// Replaces the settings in use (for tests, and after loading).
export function useConfig(settings, problem = null) {
  for (const k of Object.keys(C)) delete C[k];
  Object.assign(C, merge(DEFAULTS, settings), { problem });
  C.roots = C.roots.map(expandHome);
}

const expandHome = (p) => p.replace(/^~(?=\/|$)/, home());

// Program names to absolute paths via your login shell, which has the PATH a
// terminal would (an app started from a launcher may not). Absolute paths and
// names not found are kept as given.
async function resolvePrograms(programs) {
  const names = Object.values(programs).filter((p) => !p.startsWith("/"));
  if (!names.length) return programs;
  const script =
    'for p in "$@"; do printf "%s=%s\\n" "$p" "$(command -v "$p")"; done';
  const r = await exec("/bin/sh", [
    "-c",
    '"${SHELL:-/bin/sh}" -lc "$0" sh "$@"',
    script,
    ...names,
  ]).catch(() => null);
  const found = new Map();
  for (const line of r?.stdout.split("\n") ?? []) {
    const i = line.indexOf("=");
    if (i > 0) found.set(line.slice(0, i), line.slice(i + 1));
  }
  return Object.fromEntries(
    Object.entries(programs).map(([k, p]) => [
      k,
      p.startsWith("/") ? p : found.get(p)?.startsWith("/") ? found.get(p) : p,
    ]),
  );
}
