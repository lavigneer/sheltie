---
description:
  Push this branch, open a draft PR for its ticket, and get CI green
argument-hint: "[anything to mention in the PR]"
---

Open a draft pull request for the work on this branch, then make CI pass.

1. Find the ticket from the current branch name: a Jira key (e.g.
   `me/WEB-142` → `WEB-142`; read it with `jira issue view <KEY> --plain`), or a
   GitHub issue number (e.g. `issue-12` → #12 in this repo; read it with
   `gh issue view 12`).
2. Make sure everything is committed: review `git status` and `git diff`, and
   commit what belongs to the change with a clear message that starts with the
   ticket (`WEB-142: …` or `#12: …`). Don't commit unrelated files.
3. Push: `git push -u origin HEAD`.
4. If a PR already exists for this branch (`gh pr view --json url,isDraft`),
   skip to step 5. Otherwise create it as a draft with `gh pr create --draft`:
   - Title: `<KEY>: <short summary of the change>` for Jira; for a GitHub issue
     just the summary.
   - Body: what changed and why (a few bullets), how it was tested, and the
     ticket: a link for Jira (`jira open <KEY> --no-browser` prints its URL),
     or `Closes #12` for a GitHub issue. Use the repo's PR template if it has
     one (`.github/pull_request_template.md`).
5. Wait for CI: `gh pr checks --watch --fail-fast`. If a check fails, read the
   failing logs (`gh run view <run-id> --log-failed`), fix the cause, commit,
   push, and watch again. After three failed rounds, stop and summarise what's
   failing and why.
6. Finish with the PR URL and the CI result.

Don't mark the PR ready for review, request reviewers or merge: that's left to
me.

$ARGUMENTS
