// Settings: <Herdr app home>/sheltie.json, merged over the defaults below.
// Every mod awaits configReady() before using them; `C` holds the result.
// See config.example.json for what each setting does.

import { appHome, exec, home } from "herdr";

export const DEFAULTS = {
  // Where your git repos are: folders `depth` levels below each root.
  roots: ["~/workspace"],
  depth: 1,

  // Programs, found on your login shell's PATH unless given as absolute paths.
  // Each is needed only by what uses it: jira only with the Jira tracker,
  // sqlite3 only once opencode has a database to read.
  programs: { git: "git", gh: "gh", jira: "jira", hc: "hc", jq: "jq", curl: "curl", sqlite3: "sqlite3" },

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
    // First message for ad-hoc work (not tied to a ticket), started from the
    // tickets popup in a new worktree on {branch}; {description} is what you
    // typed.
    adhocTask:
      "{description}\n\nThis is ad-hoc work, not tied to a ticket: you're in a new worktree on branch {branch}. When the pull request is complete, run `hc label \"$HC_TERMINAL_ID\" pr=ready`.",
    // What each Work sidebar step sends to the agent.
    steps: {
      "draft-pr": "/draft-pr",
      "fix-ci": "/fix-ci",
      "address-comments": "/address-comments",
      "resolve-conflicts": "/resolve-conflicts",
    },
  },

  usage: {
    // Whose session logs count toward the Usage sidebar and each Work row's
    // cost: `type` "claude-code", "codex" or "opencode", in `home`
    // (CLAUDE_CONFIG_DIR, CODEX_HOME, opencode's data folder). An agent you don't use costs nothing to list.
    agents: [
      { type: "claude-code", home: "~/.claude" },
      { type: "codex", home: "~/.codex" },
      { type: "opencode", home: "~/.local/share/opencode" },
    ],
    // Model prices: LiteLLM's list (downloaded when it changes, at most hourly).
    prices:
      "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
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
  const { over, problem } = await readSettings(`${appHome()}/${SETTINGS_FILE}`);
  const settings = merge(DEFAULTS, over);
  settings.programs = await resolvePrograms(settings.programs);
  useConfig(settings, problem);
}

// A settings file: { over (its JSON object, {} if missing or bad), problem }.
export async function readSettings(path) {
  const r = await exec("cat", [path]).catch((e) => ({ code: 1, stderr: `${e}` }));
  if (r.code !== 0)
    return {
      over: {},
      problem: /no such file/i.test(r.stderr ?? "")
        ? null
        : `couldn't read ${path}: ${(r.stderr ?? "").trim()}`,
    };
  try {
    const over = JSON.parse(r.stdout);
    if (!isObject(over)) throw new Error("not a JSON object");
    return { over, problem: null };
  } catch (e) {
    return { over: {}, problem: `${path}: ${e.message ?? e}; using the defaults` };
  }
}

// A repo's own settings: REPO_FILE in its main checkout, merged over the
// global ones. Only REPO_SETTINGS apply there: where its tickets come from,
// its branch names and its PR workflow.
export const REPO_FILE = ".sheltie.json";
export const REPO_SETTINGS = ["tracker", "jira", "github", "branch", "workflow"];

// The settings for a repo whose REPO_FILE holds `over`, or null when it sets
// none of REPO_SETTINGS (the global ones apply). `problem` names keys that
// don't apply in a repo.
export function repoSettings(over, path) {
  const picked = Object.fromEntries(
    REPO_SETTINGS.filter((k) => k in over).map((k) => [k, over[k]]),
  );
  const ignored = Object.keys(over).filter((k) => !REPO_SETTINGS.includes(k));
  return {
    settings: Object.keys(picked).length ? merge(C, picked) : null,
    problem: ignored.length
      ? `${path}: ${ignored.join(", ")} can only be set in ${SETTINGS_FILE}`
      : null,
  };
}

// The settings for work in `repo` (from localRepos): its own, or the global ones.
export const settingsOf = (repo) => repo?.settings ?? C;

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
