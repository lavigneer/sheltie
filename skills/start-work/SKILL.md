---
name: start-work
description:
  Pick tickets to work on and start each one in its own worktree and agent
  space, in dependency order
---

Start work on tickets the way the Tickets popup (Ctrl+Shift+J) does, so
several agents can run at once without me picking each ticket by hand. You're
the hub: you choose and start the work, and other agents do it.

Use whatever you have for talking to GitHub and Jira (an MCP server, a CLI
such as `gh` or `jira`, a custom script, or the API); the steps say what to
do, not which tool to do it with.

1. Read the settings: `sheltie.json` in `$HERDR_APP_HOME`, else
   `~/.config/herdr-app`. Anything it leaves out has the default shown in
   `config.example.json` in the sheltie repo. You need `branch` (default
   `me/{ref}`), `worktreeDir` (`.worktrees`), `agent.argv` (`["claude"]`) and
   `agent.task`, and for GitHub `github.ref` (`issue-{number}`).
2. Pick the tickets: the ones I named, or (if I didn't) my open ones, as the
   tracker lists them (`tracker` in the settings). Skip tickets that already
   have work: a branch, worktree or PR for them (`herdr-app do work.report`
   writes the Work sidebar's rows to `<app home>/work-report.json`).
3. Order them: read each ticket, and note what it depends on (it says
   "depends on", "blocked by", "after #12", or the tracker links it). Start
   now only the tickets whose dependencies are done (merged). Tell me the
   order and which ones wait, then start the first batch.
4. Start each ticket, in the repo it belongs to (the issue's repo, a
   `repoRules` match, or ask me):
   - The branch: `branch` with `{ref}` filled in: a Jira key (`WEB-142`), or
     `github.ref` for an issue (`issue-12`). The worktree:
     `<repo>/<worktreeDir>/<the branch's last /-segment>`. Make sure
     `/<worktreeDir>/` is in the repo's `.git/info/exclude` (or ignored).
   - `git fetch origin`, then `git worktree add -b <branch> <worktree>
     origin/<default branch>`. If the branch already exists locally or on
     origin, use it instead (`git worktree add <worktree> <branch>`): never
     replace existing work with an empty branch.
   - Open its space with the agent and its first message:

     ```sh
     herdr-app do space.new '{"name": "<label>", "folder": "<worktree>",
       "argv": <agent.argv>, "task": "<agent.task filled in>"}'
     ```

     `<label>` is the ticket as the sidebar names it (`WEB-142`, `#12`). In
     `agent.task` fill `{key}`, `{summary}`, `{label}`, `{branch}`,
     `{worktreeDir}` and `{viewCommand}`: `gh issue view <n> --repo
     <owner/repo> --comments` for GitHub, `jira issue view <key> --plain
     --comments 20` for Jira. Build the JSON with `jq` so quotes and
     newlines in the summary survive.
   - For Jira, move the ticket by `jira.transitions.start` if it's set.
5. Waiting tickets: when I ask (or if you're still running), check
   `herdr-app do work.report` and the PRs; once a ticket's dependencies have
   merged, start it as in step 4 (cut from the updated default branch).
6. Finish with what you started (ticket, repo, worktree) and what's still
   waiting on what.

Don't do the tickets' work yourself, mark PRs ready, merge, or start more
than I asked for.
