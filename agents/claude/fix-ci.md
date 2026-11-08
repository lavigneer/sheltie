---
description: Fix the failing CI checks on this branch's PR and push
argument-hint: "[which check, or extra guidance]"
---

CI is failing on this branch's pull request. Fix it.

1. First check that the PR can merge:
   `gh pr view --json mergeable,mergeStateStatus,baseRefName`. GitHub runs no
   CI on a PR that conflicts with its base, so `gh pr checks --watch` would
   wait forever. `mergeable` can be `UNKNOWN` for a little while after a push:
   ask again every few seconds, for up to a minute, until it's `MERGEABLE` or
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

   A PR that conflicted had no CI to fix: once the merge is pushed, go to
   step 5.
2. List the checks: `gh pr checks`. For each failing one, read its logs
   (`gh run view <run-id> --log-failed`, or the check's link for external CI).
3. Find the cause. If it's a flaky or infrastructure failure unrelated to this
   change, rerun it (`gh run rerun <run-id> --failed`) instead of changing code,
   and say so.
4. Otherwise fix it, commit with a message starting with the ticket from the
   branch name (`WEB-142: …` or `#12: …`), and push.
5. Check it can still merge (as in step 1), then watch again:
   `gh pr checks --watch --fail-fast`. After three failed rounds,
   stop and summarise what's failing and why.

Don't change the PR's draft or ready state, request reviews or merge.

When the pull request is complete (nothing left that you planned for it), run
`hc label "$HC_TERMINAL_ID" pr=ready` so the Work sidebar offers Ready. If
there's still more to do, don't.

$ARGUMENTS
