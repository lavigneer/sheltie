// The defaults, which sheltie.json is merged over. What each setting does is
// in types/settings.d.ts; scripts/build.mjs makes sheltie.schema.json from
// that and these (so this module imports nothing Node can't load).

/** @type {import("../types/settings.js").Settings} */
export const DEFAULTS = {
  roots: ["~/workspace"],
  depth: 1,
  programs: {
    git: "git",
    gh: "gh",
    jira: "jira",
    hc: "hc",
    jq: "jq",
    curl: "curl",
    sqlite3: "sqlite3",
    claude: "claude",
  },
  tracker: "jira",
  jira: {
    jql: "project IS NOT EMPTY AND assignee = currentUser() AND resolution = Unresolved",
    transitions: { start: null, review: null, done: "Resolved" },
    resolution: null,
  },
  github: {
    repos: [],
    assignee: "@me",
    search: "",
    ref: "issue-{number}",
    closeOnFinish: true,
  },
  githubOwners: [],
  repoRules:
    /** @type {{ component?: string, label?: string, project?: string, repo: string }[]} */ ([]),
  branch: "{ref}",
  worktreeDir: ".worktrees",
  agent: {
    argv: ["claude"],
    task: 'Work on {key}: {summary}\n\nRun `{viewCommand}` for the description and comments. When the pull request is complete, run `hc label "$HC_TERMINAL_ID" pr=ready`.',
    extraBranchTask:
      'Start another piece of work for {key}: {summary}\n\nCreate a git worktree under {worktreeDir}/ in this repo on a new branch named {branch}-<short-description> (pick a short kebab-case description of the change), then work in it. Run `{viewCommand}` for the description and comments. When the pull request is complete, run `hc label "$HC_TERMINAL_ID" pr=ready`.',
    adhocTask:
      '{description}\n\nThis is ad-hoc work, not tied to a ticket: you\'re in a new worktree on branch {branch}. When the pull request is complete, run `hc label "$HC_TERMINAL_ID" pr=ready`.',
    steps: {
      "draft-pr": "/draft-pr",
      "fix-ci": "/fix-ci",
      "address-comments": "/address-comments",
      "resolve-conflicts": "/resolve-conflicts",
    },
  },
  usage: {
    agents: [
      { type: "claude-code", home: "~/.claude" },
      { type: "codex", home: "~/.codex" },
      { type: "opencode", home: "~/.local/share/opencode" },
    ],
    prices:
      "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  },
  workflow: {
    autoMerge: "when-reviews-required",
    readyWhen: "green",
    mergeWithoutReview: true,
    confirmMerge: true,
    confirmFinish: true,
  },
};
