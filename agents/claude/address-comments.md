---
description: Address the unresolved review comments on this branch's PR and push
argument-hint: "[which comments, or extra guidance]"
---

Address the open review feedback on this branch's pull request.

Use whatever you have for talking to GitHub and Jira (an MCP server, a CLI
such as `gh` or `jira`, a custom script, or the API); the steps say what to
do, not which tool to do it with.

1. Find this branch's PR and its repo.
2. Fetch the unresolved review threads with their comments (path, line,
   whether outdated, and each comment's author and body). With `gh`, for
   example:

   ```sh
   gh api graphql -F owner=<owner> -F name=<name> -F number=<number> -f query='
     query($owner: String!, $name: String!, $number: Int!) {
       repository(owner: $owner, name: $name) {
         pullRequest(number: $number) {
           reviewThreads(first: 100) {
             nodes {
               id isResolved isOutdated path line
               comments(first: 50) { nodes { id databaseId author { login } body url } }
             }
           }
         }
       }
     }'
   ```

   Also read top-level review bodies and PR comments for feedback that isn't
   attached to a line.

3. For each unresolved thread: make the change it asks for, or, if you disagree
   or it's unclear, don't change the code and say why in your reply. Group
   related fixes into sensible commits whose messages start with the ticket
   from the branch name (`WEB-142: …` or `#12: …`).
4. Push, then reply on each thread you handled with what you did.
   Resolve a thread only if its first comment is mine (the login you're
   authenticated as); leave other reviewers' threads for them to
   resolve.
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
6. Wait for CI (watch the checks, stopping at the first failure) and fix
   failures: read the failing logs, fix, commit, push, and
   watch again; after three failed rounds, stop and say what's failing.
7. Finish with a short list: each thread, and what you did or why you didn't
   (and any conflicts you resolved).

Don't change the PR's draft or ready state, request reviews or merge.

When the pull request is complete (nothing left that you planned for it), run
`hc label "$HC_TERMINAL_ID" pr=ready` so the Work sidebar offers Ready. If
there's still more to do, don't.

$ARGUMENTS
