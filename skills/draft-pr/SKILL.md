---
name: draft-pr
description:
  Push this branch, open a draft PR for its ticket, and get CI green
---

Open a draft pull request for the work on this branch, then make CI pass.

Use whatever you have for talking to GitHub and Jira (an MCP server, a CLI
such as `gh` or `jira`, a custom script, or the API); the steps say what to
do, not which tool to do it with.

1. Find the ticket from the current branch name: a Jira key (e.g.
   `me/WEB-142` → `WEB-142`), or a GitHub issue number (e.g. `issue-12` → #12
   in this repo). Read the ticket.
2. Make sure everything is committed: review `git status` and `git diff`, and
   commit what belongs to the change with a clear message that starts with the
   ticket (`WEB-142: …` or `#12: …`). Don't commit unrelated files.
3. Push: `git push -u origin HEAD`.
4. If a PR already exists for this branch,
   skip to step 5. Otherwise create it as a draft:
   - Title: `<KEY>: <short summary of the change>` for Jira; for a GitHub issue
     just the summary.
   - Body: what changed and why (a few bullets), how it was tested, and the
     ticket: a link for Jira,
     or `Closes #12` for a GitHub issue. Use the repo's PR template if it has
     one (`.github/pull_request_template.md`).
5. Before waiting for CI, check that the PR can merge: look up
   its base branch and mergeable state. GitHub runs no CI on a PR that
   conflicts with its base, so waiting for checks would wait forever. The
   mergeable state can be `UNKNOWN` for a little while after a push: ask again
   every few seconds, for up to a minute, until it's `MERGEABLE` or
   `CONFLICTING`, and don't read `UNKNOWN` as either. If it's `CONFLICTING`:
   1. merge the base in: `git fetch origin && git merge origin/<base>` (never
      rebase or force-push a branch that has a PR);
   2. resolve the conflicts, keeping both sides' intent (read what the base
      changed, `git log -p HEAD..origin/<base> -- <file>`, and combine it with
      this branch's change); regenerate committed generated files (built
      output, lockfiles) with the repo's build instead of merging them by
      hand;
   3. rebuild anything generated and run the tests;
   4. commit with the ticket prefix (e.g. `#12: merge main`), push, and only
      then watch CI.

   If a conflict can't be resolved with confidence, `git merge --abort`, stop
   and say which files and why.
6. Wait for CI: watch the PR's checks until they finish, stopping at the first
   failure. If a check fails, read its failing logs, fix the cause, commit,
   push, check it can still merge (step 5), and watch again. After three
   failed rounds, stop and summarise what's failing and why.
7. Finish with the PR URL, the CI result and any conflicts you resolved.

Don't mark the PR ready for review, request reviewers or merge: that's left to
me.

When the pull request is complete (nothing left that you planned for it), run
`hc label "$HC_TERMINAL_ID" pr=ready` so the Work sidebar offers Ready. If
there's still more to do, don't.
