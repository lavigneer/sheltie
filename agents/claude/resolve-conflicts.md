---
description: Merge the base branch into this branch's PR, resolve the conflicts, and push
argument-hint: "[extra guidance on the conflicts]"
---

This branch's pull request conflicts with its base branch, so GitHub won't run
its CI. Resolve that.

1. Find the PR and its base: `gh pr view --json number,url,baseRefName,mergeable,mergeStateStatus`.
   `mergeable` can be `UNKNOWN` for a little while (GitHub works it out
   lazily): ask again every few seconds, for up to a minute, until it's
   `MERGEABLE` or `CONFLICTING`. Don't read `UNKNOWN` as either. If it's
   `MERGEABLE`, there's nothing to resolve: skip to step 6.
2. Make sure the working tree is clean (`git status`): commit what belongs to
   the change first, with a message that starts with the ticket from the
   branch name (`WEB-142: …` or `#12: …`).
3. Merge the base in: `git fetch origin && git merge origin/<base>`. Never
   rebase or force-push a branch that has a PR.
4. Resolve each conflict, keeping both sides' intent: read what the base
   changed (`git log -p HEAD..origin/<base> -- <file>`) as well as this
   branch's change, and combine them rather than picking one side. For
   generated files that are committed (built output, lockfiles, snapshots),
   take either side and regenerate them with the repo's own build (see its
   README, CONTRIBUTING or CI) instead of merging them by hand. If a conflict
   can't be resolved with confidence, stop (`git merge --abort`) and say which
   files and why.
5. Rebuild anything generated, run the tests, then commit the merge (its
   message starting with the ticket, e.g. `#12: merge main`) and push
   (`git push`).
6. Wait for CI: `gh pr checks --watch --fail-fast`. If a check fails, read the
   failing logs (`gh run view <run-id> --log-failed`), fix the cause, commit,
   push, and watch again. After three failed rounds, stop and summarise what's
   failing and why.
7. Finish with what conflicted, how you resolved it, and the CI result.

Don't change the PR's draft or ready state, request reviews or merge.

When the pull request is complete (nothing left that you planned for it), run
`hc label "$HC_TERMINAL_ID" pr=ready` so the Work sidebar offers Ready. If
there's still more to do, don't.

$ARGUMENTS
