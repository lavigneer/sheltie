---
description: Fix the failing CI checks on this branch's PR and push
argument-hint: "[which check, or extra guidance]"
---

CI is failing on this branch's pull request. Fix it.

1. List the checks: `gh pr checks`. For each failing one, read its logs
   (`gh run view <run-id> --log-failed`, or the check's link for external CI).
2. Find the cause. If it's a flaky or infrastructure failure unrelated to this
   change, rerun it (`gh run rerun <run-id> --failed`) instead of changing code,
   and say so.
3. Otherwise fix it, commit with a message starting with the ticket from the
   branch name (`WEB-142: …` or `#12: …`), and push.
4. Watch again: `gh pr checks --watch --fail-fast`. After three failed rounds,
   stop and summarise what's failing and why.

Don't change the PR's draft or ready state, request reviews or merge.

When the pull request is complete (nothing left that you planned for it), run
`hc label "$HC_TERMINAL_ID" pr=ready` so the Work sidebar offers Ready. If
there's still more to do, don't.

$ARGUMENTS
