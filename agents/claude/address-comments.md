---
description: Address the unresolved review comments on this branch's PR and push
argument-hint: "[which comments, or extra guidance]"
---

Address the open review feedback on this branch's pull request.

1. Find the PR: `gh pr view --json number,url,headRefName`, and the repo:
   `gh repo view --json owner,name`.
2. Fetch the unresolved review threads with their comments:

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

   Also read top-level review bodies and PR comments (`gh pr view --comments`)
   for feedback that isn't attached to a line.

3. For each unresolved thread: make the change it asks for, or, if you disagree
   or it's unclear, don't change the code and say why in your reply. Group
   related fixes into sensible commits whose messages start with the ticket
   from the branch name (`WEB-142: …` or `#12: …`).
4. Push, then reply on each thread you handled with what you did
   (`gh api repos/<owner>/<name>/pulls/<number>/comments/<databaseId>/replies -f body=…`).
   Resolve a thread only if its first comment is mine
   (`gh api user --jq .login`); leave other reviewers' threads for them to
   resolve.
5. Wait for CI (`gh pr checks --watch --fail-fast`) and fix failures as in
   /draft-pr.
6. Finish with a short list: each thread, and what you did or why you didn't.

Don't change the PR's draft or ready state, request reviews or merge.

When the pull request is complete (nothing left that you planned for it), run
`hc label "$HC_TERMINAL_ID" pr=ready` so the Work sidebar offers Ready. If
there's still more to do, don't.

$ARGUMENTS
