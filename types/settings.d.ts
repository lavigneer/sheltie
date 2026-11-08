// The settings file's shape, with what each setting does. scripts/build.mjs
// generates sheltie.schema.json from this (with the defaults from
// src/defaults.js), so describe settings here, not there.

/**
 * sheltie.json in the Herdr app home, or a repo's .sheltie.json (there only
 * tracker, jira, github, branch and workflow apply). Merged over the
 * defaults: set only what you change.
 * @title sheltie settings
 */
export interface Settings {
  /** The JSON schema these settings follow, for editors. */
  $schema?: string;
  /** Where your git repos are: folders `depth` levels below each root. ~ is your home folder. */
  roots: string[];
  /**
   * How many levels below each root your repos are.
   * @asType integer
   * @minimum 0
   */
  depth: number;
  /**
   * Programs, found on your login shell's PATH unless given as absolute
   * paths. Each is needed only by what uses it.
   */
  programs: {
    git: string;
    gh: string;
    /** jira-cli, only with the Jira tracker. */
    jira: string;
    hc: string;
    jq: string;
    curl: string;
    /** Only once opencode has a database to read. */
    sqlite3: string;
    /** For the Usage sidebar's plan limits. */
    claude: string;
  };
  /** Where tickets come from: "jira" (jira-cli) or "github" (GitHub issues, gh). */
  tracker: "jira" | "github";
  jira: {
    /**
     * Which tickets to list (jira-cli adds the ORDER BY). Naming `project`
     * makes jira-cli search every project, not just its default one.
     */
    jql: string;
    /** Jira transitions at each step, or null for none. */
    transitions: {
      start: string | null;
      review: string | null;
      done: string | null;
    };
    /** Resolution set with the `done` transition, if its screen asks for one. */
    resolution: string | null;
  };
  github: {
    /** Repos (owner/repo) to list open issues from; empty: anywhere you can see. */
    repos: string[];
    /** List issues assigned to this user ("@me": you). */
    assignee: string;
    /** Extra GitHub search terms, e.g. "label:bug". */
    search: string;
    /** The issue's part of a branch name; {number} is the issue number. */
    ref: string;
    /** Close the issue at Finish if merging its PR didn't already. */
    closeOnFinish: boolean;
  };
  /**
   * GitHub orgs/users searched for pull requests that mention a ticket, in
   * addition to the owners of your local repos and of the repos in repoRules.
   */
  githubOwners: string[];
  /**
   * Where new work on a ticket goes. Each rule matches a ticket by any of
   * component, label or project (the Jira project key, or the issue's
   * owner/repo) and names a repo: "owner/repo" on GitHub (cloned into the
   * first root if needed) or a local path. Component and label rules win
   * over project rules.
   */
  repoRules: {
    component?: string;
    label?: string;
    project?: string;
    repo: string;
  }[];
  /** A ticket's branch: {ref} is the tracker's part (WEB-142, issue-12), e.g. "me/{ref}". */
  branch: string;
  /** Where ticket worktrees go, relative to the repo's main checkout. */
  worktreeDir: string;
  agent: {
    /**
     * The agent started in a ticket's space; its first message is the last
     * argument (as with `claude "<task>"`).
     * @minItems 1
     */
    argv: string[];
    /**
     * First message for new work. {key}, {summary}, {url}, {branch} and
     * {viewCommand} (how to read the ticket) are filled in. It says how to
     * tell the Work sidebar the PR is done (see workflow.readyWhen).
     */
    task: string;
    /**
     * First message when asking for another branch of a ticket in a repo
     * that already has one: the agent names and creates it itself. Also
     * {worktreeDir}.
     */
    extraBranchTask: string;
    /**
     * First message for ad-hoc work (not tied to a ticket), started from the
     * tickets popup in a new worktree on {branch}; {description} is what you
     * typed.
     */
    adhocTask: string;
    /** What each Work sidebar step sends to the agent. */
    steps: {
      "draft-pr": string;
      "fix-ci": string;
      "address-comments": string;
      "resolve-conflicts": string;
    };
  };
  usage: {
    /**
     * Whose session logs count toward the Usage sidebar and each Work row's
     * cost: `type` in `home` (CLAUDE_CONFIG_DIR, CODEX_HOME, opencode's data
     * folder). An agent you don't use costs nothing to list.
     */
    agents: { type: "claude-code" | "codex" | "opencode"; home: string }[];
    /**
     * URL of a LiteLLM-format model price list (file:// works), downloaded
     * when it changes, at most hourly.
     */
    prices: string;
  };
  workflow: {
    /**
     * At Ready: turn on auto-merge "when-reviews-required" (it then merges
     * on approval and never at once), or "never" (merge with the Merge step).
     */
    autoMerge: "when-reviews-required" | "never";
    /**
     * When a draft PR is offered Ready: "green" (CI passed, no conflicts with
     * its base and nothing unresolved; a PR with no checks isn't green), or
     * "agent" (also only once its agent says the PR is done, by labelling its
     * terminal: `hc label "$HC_TERMINAL_ID" pr=ready`; the label is cleared
     * whenever a step is sent to the agent). Use "agent" with agents that
     * know this (the skills in skills/ do).
     */
    readyWhen: "green" | "agent";
    /**
     * Offer Merge for a ready, green PR that needs no review (a repo without
     * required reviews), not only for an approved one; false: merge those in
     * the browser.
     */
    mergeWithoutReview: boolean;
    /** Merge asks for a second click. */
    confirmMerge: boolean;
    /** Finish and Clean up ask for a second click. */
    confirmFinish: boolean;
  };
}
