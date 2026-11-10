---
name: review-pr
description: First-pass review of a PR, drafted locally; never posts to GitHub unless asked
---

Give the pull request `$ARGUMENTS` (a PR number; if none is given, the PR for
this worktree's branch) a first-pass review, and draft the comments locally
for me to read. You're running in a review worktree checked out on the PR.

Use whatever you have for talking to GitHub (an MCP server, a CLI such as
`gh`, a custom script, or the API); the steps say what to do, not which tool
to do it with.

**Never post anything to GitHub**: no review, no comment, no reply, no
reaction, no approval or request for changes, no label or state change.
Reading is fine. Post only if I explicitly ask you to in this conversation,
and then only what I asked for.

1. Read the PR: title, body, base branch, the ticket it links (if any), and
   the existing review threads and comments, so you don't repeat what's
   already been said.
2. Read the diff against the base (`git fetch origin` then
   `git diff origin/<base>...HEAD`), and the surrounding code it touches, not
   just the changed lines.
3. Review for, in order of importance: correctness bugs (inputs or states
   that give a wrong result or a crash), missing or wrong tests, behaviour
   the ticket asks for that's missing, security and data-loss risks, then
   simpler or clearer ways to do the same thing. Check a suspicion against
   the code (or run the tests) before you write it down; drop what you can't
   back up. Skip style nits a formatter or linter would catch.
4. Don't change the code, commit or push.
5. Write the draft to `review-<number>.md` at the worktree root (don't commit
   it): a short overall summary, then one entry per comment, most important
   first, each with the file and line, what's wrong, a concrete case where it
   goes wrong (or why it matters), and a suggested fix. Write each comment as
   it would read posted on the PR.
6. Finish by printing the summary and the list of comments (file:line and a
   one-line gist each), and the path of the draft.
