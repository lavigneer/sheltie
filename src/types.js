// The data shapes the shared modules pass around, for the type checker
// (npm run typecheck). Only JSDoc refers to this file (import("./types.js")),
// so scripts/build.mjs never copies it into mods/.

/** @typedef {import("./config.js").Settings} Settings */

/**
 * A ticket from a tracker's list() or view(). listTickets adds `tracker` (the
 * one that listed it) and `homes` (the repos whose own tracker listed it).
 * @typedef {object} Ticket
 * @property {string} key
 * @property {string} label short form for display
 * @property {string} ref its part of a branch name
 * @property {string} summary
 * @property {string} status
 * @property {string[]} components
 * @property {string[]} labels
 * @property {string} project
 * @property {string | null} repo GitHub: the issue's "owner/repo"
 * @property {Tracker} [tracker]
 * @property {Repo[]} [homes]
 */

/**
 * A repo: a local main checkout (localRepos: `path` set) or one only known
 * by its slug (findRepo: `path` null).
 * @typedef {object} Repo
 * @property {string | null} path
 * @property {string} name
 * @property {string | null} slug "owner/repo" on GitHub, null when not there
 * @property {Settings | null} [settings] its own settings (REPO_FILE)
 * @property {Tracker | null} [tracker] its own tracker
 * @property {string | null} [problem] what's wrong with its REPO_FILE
 */

/** @typedef {"passed" | "failed" | "pending"} Checks */

/**
 * A pull request (prs.js prDetails).
 * @typedef {object} PR
 * @property {string} slug
 * @property {number} number
 * @property {string} url
 * @property {string} title
 * @property {"OPEN" | "CLOSED" | "MERGED"} state
 * @property {boolean} draft
 * @property {string | null} review reviewDecision, e.g. "APPROVED"
 * @property {Checks | null} checks null when the PR has no checks
 * @property {number} [checksPassed] how many of its checks passed
 * @property {number} [checksTotal] how many checks it has
 * @property {string} branch
 * @property {string} head
 * @property {boolean} autoMerge
 * @property {"MERGEABLE" | "CONFLICTING" | "UNKNOWN"} mergeable
 * @property {"MERGEABLE" | "CONFLICTING" | null} settled the last mergeable
 *   GitHub had worked out (carried over while it's UNKNOWN)
 * @property {number | null} unresolved unresolved review threads (open PRs)
 */

/** A PR a tracker links to a ticket. @typedef {{ slug: string, number: number }} PRRef */

/**
 * One piece of work on a ticket (work.js workFor): a branch, maybe checked out
 * in a worktree, maybe with a PR.
 * @typedef {object} WorkItem
 * @property {Repo} repo
 * @property {string | null} branch
 * @property {string | null} worktree
 * @property {PR | null} pr
 */

/** @typedef {"start" | "review" | "done"} Step */

/**
 * A ticket tracker (tracker.js; made by tracker-jira.js and tracker-github.js).
 * @typedef {object} Tracker
 * @property {string} name
 * @property {() => Promise<Ticket[]>} list your tickets
 * @property {(key: string) => Promise<Ticket | null>} view null when there's
 *   no such ticket; throws when the tracker can't be reached
 * @property {(key: string, step: Step, status?: string | null) => Promise<string | null>} move
 *   returns a note, or null when there's nothing to do
 * @property {(key: string) => Promise<string | null>} url where to see it in
 *   the browser, null when it can't tell
 * @property {(key: string) => string} viewCommand a shell command that prints it
 * @property {(key: string) => string} labelOf
 * @property {(text: string | null, slug?: string | null) => string[]} keysIn
 *   keys a branch name or PR text (in repo slug) mentions
 * @property {(keys: string[], repos: Repo[]) => Promise<Map<string, PRRef[]>>} linkedPRs
 * @property {(ticket: Ticket) => { target: string, why: string }[]} suggest
 *   repos the tracker itself suggests
 */

export {};
