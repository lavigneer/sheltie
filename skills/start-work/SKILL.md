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

`<app home>` below is `$HERDR_APP_HOME`, else `~/.config/herdr-app`.

1. Pick the tickets: the ones I named, or (if I didn't) my open ones, as the
   tracker lists them (`tracker` in `<app home>/sheltie.json`).
2. Order them: read each ticket, and note what it depends on (it says
   "depends on", "blocked by", "after #12", or the tracker links it). Start
   now only the tickets whose dependencies are done (merged). Tell me the
   order and which ones wait.
3. Start the ready ones in one go: write `<app home>/work-start.json`, then run
   `herdr-app do work.start` (the Work sidebar must be showing, as in the
   `sheltie` layout):

   ```json
   { "tickets": ["WEB-142", "acme/web#12", { "ticket": "WEB-150", "repo": "acme/api" }] }
   ```

   Name a ticket by its key (`WEB-142`, `owner/repo#12`) or its label as the
   sidebar shows it; add `repo` (`owner/repo` or a path) only when its best
   suggested repo would be wrong. Each one gets its branch and worktree, the
   tracker's start step, and a space with the agent and the ticket as its
   first message. Tickets that already have a branch, worktree or PR are
   skipped.
4. A few seconds later, read `<app home>/work-started.json`: `{ at, results }`
   with one `{ ticket, status, repo?, folder?, why? }` per ticket (`status`
   `started`, `skipped` or `failed`), or `{ at, error }` if the request was
   bad. Check that `at` is after you ran the command; if it isn't yet, wait
   and read it again.
5. Waiting tickets: when I ask (or if you're still running), check which
   dependencies have merged (`herdr-app do work.report` writes the sidebar's
   rows, with their PRs, to `<app home>/work-report.json`) and start the
   tickets that are now ready, as in step 3.
6. Finish with what started (ticket, repo, folder), what was skipped or
   failed and why, and what's still waiting on what.

Don't do the tickets' work yourself, mark PRs ready, merge, or start more
than I asked for.
