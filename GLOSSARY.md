# Sheltie

A suite of Herdr mods. Its core is the ticket flow: taking a ticket from a tracker to a merged pull request without leaving Herdr.

## Language

### Tickets

**Ticket**:
A unit of requested work in a tracker, identified by its key.
_Avoid_: Issue (except when it means a GitHub issue specifically), task

**Tracker**:
The system tickets live in: Jira or GitHub Issues.

**Global tracker**:
The tracker used for every repo that doesn't pick its own.

**Repo tracker**:
A tracker a repo picks for itself, overriding the global tracker for that repo's tickets and branches.

**Issue repo**:
The GitHub repo a ticket lives in as an issue. It may hold no code; Jira tickets have none.
_Avoid_: The ticket's repo

**Home repo**:
A repo whose repo tracker lists the ticket: where its work is expected to go. A ticket may have several, or none.
_Avoid_: The ticket's repo

**Ad-hoc work**:
Work started from a typed description instead of a ticket. It follows the same flow, with no ticket to move.

### Repos and checkouts

**Repo**:
A git repository, known by its local main checkout, its GitHub slug, or both.
_Avoid_: Project (that's a tracker's grouping of tickets)

**Hub**:
A repo's main checkout, with its own space for longer-running agents. It has no ticket, PR or steps.
_Avoid_: Main worktree

**Worktree**:
A linked git worktree created for one piece of work on its own branch. It belongs to the repo whose main checkout it was linked from.

**Space**:
The Herdr workspace opened in a worktree or hub, where its agent runs.
_Avoid_: Workspace, pane

**Ticket status**:
Where a ticket stands in its tracker. The flow moves it on start, when its PR goes up for review, and when it resolves.
_Avoid_: Step, stage (both mean something else here)

**Resolved**:
A ticket with no open work left. A ticket with work in several repos, or on several machines, stays open until all of it is merged or closed.

**Open work**:
Any branch or PR for a ticket that hasn't merged or closed, whether or not it's checked out here. Broader than the ticket's work items.

### Starting work

**Repo suggestion**:
A repo proposed for a ticket when its work starts, with the reason it was proposed, ranked best first.

**Repo rule**:
A user-written mapping from a ticket's component, label or project to the repo its work belongs in.

**Start request**:
A request from an agent or script to start work on one or more tickets, answered with a start result per ticket: started, skipped or failed.
_Avoid_: Job, queue entry

### The flow

**Work item**:
One piece of work on a ticket (or ad-hoc work) in one repo: a branch checked out in a worktree, maybe with a PR. A branch with no local worktree is not a work item.

**Row**:
A work item as the Work sidebar shows it. Each row is exactly one work item; a repo's hub is shown alongside its rows but is not one.
_Avoid_: Hub row

**Review**:
A PR in one of your repos that requests your review (from you or a team you're on), as the Reviews sidebar shows it. It leaves once you've reviewed it, until you're asked again. Not a work item: it's someone else's work.
_Avoid_: Row, work item

**PR stage**:
Where a work item's PR stands: no PR, draft, in review, approved, merged or closed.
_Avoid_: PR status, ticket status

**Step**:
An action the sidebar offers a row given its PR stage. Some are sent to the agent (Draft PR, Fix CI, Address comments, Resolve conflicts); the rest run directly (Ready, Merge, Finish, Clean up).
_Avoid_: Tracker step, action

**Finish**:
The step that ends a work item whose PR merged: its spaces close, its worktree and branch go, and its ticket resolves if no other work on it is open.

**Clean up**:
The step that ends a work item whose PR was closed without merging: the same teardown as Finish, but its ticket is left alone.
_Avoid_: Finish (for unmerged work), abandon

**Agent done**:
A work item's agent's own claim that its PR is finished. It lapses when the agent is sent another step.
_Avoid_: Ready (even though the agent signals it with a `pr=ready` label)

**Working**:
A work item whose agent is busy. It overrides Agent done: no step is sent to the agent, and Ready and Merge wait until it stops.

**Ready**:
The step that takes a PR out of draft for review; also the PR state it leaves behind.
_Avoid_: Done, agent done
