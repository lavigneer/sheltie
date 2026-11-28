# Workflow details

## Starting a ticket

Ctrl+Shift+J lists your tickets. Enter creates the ticket's branch and a git
worktree for it, opens a space there and starts your agent with the ticket as
its first message.

Repo suggestions for a ticket, best first: the repo you last used for it,
`repoRules` matching its component or label, the tracker's own (a GitHub
issue's repo), `repoRules` matching its project (only if no component/label
rule matched), and the repo you're in. With exactly one clear choice, Enter
starts right away; otherwise you pick (or pick any repo, cloning it if needed).

## Sidebar steps

- **Draft PR**, **Fix CI**, **Address comments**, **Resolve conflicts** are
  sent to the agent in that worktree's space (as `/draft-pr`, `/fix-ci`,
  `/address-comments`, `/resolve-conflicts`). A PR that conflicts with its base
  ("conflicts" in its label) offers only Resolve conflicts, since GitHub runs
  no CI on it. The commands all check for conflicts before waiting for CI, and
  merge the base in (never rebase or force-push) to fix them.
- **Ready** marks the PR ready for review and, when the repo requires reviews,
  turns on auto-merge, so it merges on approval. It's offered once CI has
  passed (a PR with no checks isn't green, so in a repo without CI mark it
  ready on GitHub), it doesn't conflict and nothing is unresolved. With
  `workflow.readyWhen: "agent"`, it's also only offered once the agent says
  the PR is done by running `hc label "$HC_TERMINAL_ID" pr=ready` (the Claude
  commands end with that; sending the agent another step clears it).
- **Merge** is offered when the PR is approved, or the repo requires no review
  (unless `workflow.mergeWithoutReview` is `false`), CI passed, it doesn't
  conflict, and auto-merge is off. It asks for a second click.
- **Finish** (after the merge) closes the space, removes the worktree and
  local branch, and resolves the ticket.

Click a row to go to its space. Its ↗ button (on the right, shown on hover,
on the selected row and while its menu is open) opens a menu with Open PR and
Open ticket, for the browser; each shows only when the row has one, like the
keys `work.open-pr` and `work.open-ticket`.

## Hubs

Each repo's group starts with its hub: the main checkout (its branch and a
"hub" tag), with a space of its own for the repo's longer-running agents. Click
it to go to that space, or open one there with the agent. It has no ticket, PR
or steps. A repo shows while it has worktrees or its hub has a space.

## Reviews

The reviews mod lists the PRs in your repos that request your review, oldest
request first. Click a row to start the review: the PR is checked out in a
review worktree of its repo, with a space of its own and `agent.reviewTask`
sent to the agent (skipped when the worktree already exists, so its agent
isn't told again). ↗ opens the PR in the browser.

A reviewed PR keeps its row while its review worktree stays. ✓ (Done reviewing)
closes its space, removes the worktree and deletes its local branch; it
refuses if the worktree has uncommitted changes. On each refresh, a review
worktree whose PR has merged or closed is torn down the same way, and one
that refuses is kept and reported. The review layout (`herdr-app do
layout.switch --name review`) shows the Reviews sidebar with the changes panel
beside the agent.

## Notifications

You're notified when CI finishes, review comments or a review arrive, the PR
starts conflicting with its base (e.g. after another PR merges), or it merges.

## What it runs and changes

The mods run `git`, `gh`, `jira` and `hc` as you. Through them they create
branches and worktrees, push (via the agent), mark PRs ready, turn on
auto-merge, merge, delete local branches and worktrees, and move or close
tickets. Safety checks:

- Auto-merge is only turned on while a review is still required, so it can't
  merge at once.
- Finish refuses if the worktree has uncommitted changes or commits that aren't
  in the PR, asks for a second click, and leaves the ticket open while other
  work on it is still open.
- An existing branch or PR is never replaced by an empty look-alike branch.

## Keyboard

Every step also runs from the keyboard (see the README's key table). Finish
and Clean up need two presses. A row without a PR, a row whose branch isn't a
ticket, or a hub just shows a notification for keys that don't apply. The
browser opens with `xdg-open` (Linux) or `open` (macOS).

The selected row has an accent outline and its picked step an accent border.
It follows the focused space (its first step picked) until you move it, and
goes back to following when you focus another space. On a narrow sidebar the
step buttons wrap. Narrower than 160 px (like Herdr's folded sidebar), the
sidebar becomes a rail of row statuses, with each row's ticket, PR and next
steps on hover. The keys still work there.

Rows are grouped by repo, under each repo's hub. ▤ in the header (or
`work.group`) groups them by PR stage instead: No PR, Draft, In review,
Approved, Merged and Closed, in the flow's order, with each row naming its
repo and the hubs with a space in a Hubs group first. So all the work waiting
to be finished sits together under Merged. Merged and Closed open folded
(their counts show; click to unfold). `workGroupBy` in `sheltie.json`
picks the grouping the sidebar opens with.

Grouped by repo, a repo with many worktrees shows its `workRepoRows` (8)
most recently changed, plus the focused space's, and a "+k more" row that
shows the rest. The keys and `work.report` cover only the rows shown.

For scripts: `herdr-app do work.refresh` refreshes the sidebar now, like its
↻ button. `herdr-app do work.report` writes what it shows to
`<Herdr app home>/work-report.json`: rows, hubs (marked `hub: true`), their PRs
(with `mergeable`) and next steps, the selected row and step, and the PR and
ticket URLs `work.open-pr` and `work.open-ticket` would open.

It also has the performance numbers for the sidebar's own refreshes: `refreshes`
(the count, the mean, the 95th percentile and the slowest of the last 200 git
scans, and the mean calls each one ran, by program, with how many were rate
limited) and `calls` (every program run and rate-limited call since the mod
loaded). A refresh's calls are the ones made while its git scan runs: the gh and
jira lookups it starts run after that and count only in `calls`. A call from
another run that overlaps a refresh is counted in both, so `calls` is the exact
total. Both are kept in memory, so they start again when the mod does.

`quota` watches the GitHub and Jira limits: per program, `callsLastHour` (calls
that reached it in the last hour), `backingOff`, and `backoffMs` (how long since
it first answered "rate limited" without a call working since), with `alert`
once that passes 2 minutes. A backoff that long is also recorded once in
`<Herdr app home>/sheltie-diagnostics/`. `quota.graphql` is GitHub's GraphQL
points (`limit`, `used`, `remaining`, `reset`) from `gh api rate_limit`, or null.
`reviews` has the Reviews sidebar's own `refreshes` (one per queue refresh) and
`quota` (each mod counts its own calls), or null if it isn't running.

## Starting tickets from an agent or script

`herdr-app do work.start` starts the tickets each request in
`<Herdr app home>/work-start/` names, like Enter in the tickets popup. A
request is its own `<id>.json` (write it as `<id>.json.tmp` and rename it), so
several callers can ask at once: `{"tickets": ["WEB-142", {"ticket":
"acme/web#12", "repo": "acme/web"}]}` (a key or the label the sidebar shows;
`repo`, a slug or path, overrides its best suggested repo). Requests run one
at a time; each is removed once read, and what happened to each ticket is
written to `<id>.result.json` for the caller to read and delete (results left
over a day are removed). Tickets that already have open work (a branch,
worktree or PR, unless its PR is merged or closed) are skipped, as when
starting marked tickets in the popup; a worktree left from closed work is
reused, without telling its agent the task again. The `start-work` skill
(`./install.sh --skills`) teaches an agent, such as one in a repo's hub, to
pick tickets, order them by their dependencies and start the ready ones this
way, then the rest once what they wait on merges.
