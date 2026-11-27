---
name: file-sheltie-issues
description:
  Look at this Mac's sheltie failures (Herdr app diagnostics and the Herdr
  server log) and file each new one as a deduplicated GitHub issue on
  lavigneer/sheltie, or stage it for review
---

File the sheltie failures seen on this machine as issues on lavigneer/sheltie,
without filing the same one twice. Use `gh` for GitHub and the shell for the
local files.

Sources (respect `$HERDR_APP_HOME`; the defaults are below):

- `~/.config/herdr-app/sheltie-diagnostics/*.json`: one JSON record per
  failure (`at`, `mod`, `what`, `message`, `stack`, `context`). Names sort by
  time, so a name is a watermark.
- `~/.config/herdr/herdr-server.log`: ERROR and WARN lines, read from a saved
  offset.

State lives in `~/.local/state/sheltie-watcher/`: `state.json` holds the
watermark, the log offset, and what has been seen, filed or staged, keyed by
signature. `staged/` holds issue bodies waiting for review.

## Steps

1. **Load state.** If `state.json` doesn't exist, this is the first run: set
   the diagnostics watermark to the newest existing record and the log offset
   to the end of the log, and stop. Old failures stay out, as the first run is
   a baseline. Only a `--backfill`-style request processes history.

2. **Read the new diagnostics records**, oldest first, those after the
   watermark. For each record that can't be parsed, say so and move past it.
   - `what` = `slow render`: don't file it. Count it per day, counting only
     `context.ms` of 400 or more. When a day reaches 5, stage one aggregate for
     that day (see step 5), once.
   - Anything else is a candidate for auto-filing.

3. **Read the new log lines** after the offset (complete lines only).
   - Drop `update.check` failures and `No space left on device`.
   - Keep the other ERROR and WARN lines. Lines about `pane.process_info` or
     auto-title are herdr-core's, not sheltie's: tag them `herdr-core`.
   - Lines with the same signature in one run count once.

4. **Compute each candidate's signature.** Normalize the text, then hash
   `source | mod | normalized text` and keep the first 16 hex characters:
   - Replace timestamps with `TIME`, UUIDs and hex runs of 12 or more with
     `ID`, ticket keys like `DEVPROD-25882` with `TICKET`, `<n> ms` with
     `N ms`, and other numbers with `N`.
   - Scrub secrets first: GitHub, Slack and AWS tokens, JWTs, `Bearer`/`token`
     values, and passwords in URLs become `<redacted>`.
   - So one bug seen on four tickets gets one signature.

5. **Dedup before filing anything.** Skip a candidate if:
   - `state.json` already has its signature in `seen` or `staged`;
   - an open issue contains the signature: `gh issue list -R lavigneer/sheltie
     --state open --search "<sig> in:body" --json number,url`;
   - or an open issue's title contains the normalized message's first six words
     (at least four words, in quotes, with `in:title`). Use `--search` with
     that phrase.

   A candidate covered by an open issue is **not** recorded, so it gets filed
   again if it recurs after that issue is closed.

6. **File or stage.**
   - Auto-file at most **2 diagnostics issues per run**. Anything beyond that,
     and every log line and aggregate, is staged.
   - Ensure the label first. Run `gh label create automated -R
     lavigneer/sheltie --description "Filed by file-sheltie-issues"` and ignore
     "already exists".
   - Title: `[watcher] <mod>: <normalized message, at most 90 characters>`.
   - Body (write it to a file, then `gh issue create -R lavigneer/sheltie
     --title … --label automated --body-file <file>`):
     - a line `sheltie-watcher signature: \`<sig>\`` (dedup depends on it);
     - the scrubbed record in a fenced block;
     - an **Environment** block: macOS version (`sw_vers -productVersion`),
       `herdr-app --version`, `hc --version`, `jira version`, `gh --version`
       (first lines), and the sheltie revision (`git -C` the sheltie checkout,
       `rev-parse --short HEAD`), with "not found" where a tool is missing.
   - Staged: write the same body to `staged/<mod>-<sig>.md` and keep the title
     in `state.json`. Tell the user the file path and the `gh issue create`
     command.

7. **Advance and save.** Write the diagnostics watermark and the log offset
   after each step succeeds, never ahead of it. A failed `gh` call stops the run
   without advancing past the failing item, so the next run retries it.

8. **Report.** List what was filed (with URLs), what was covered by an existing
   issue, what was staged (with paths), and what was skipped as unreadable.

## Limits

- Filing needs `gh` authenticated as a user who can open issues on
  lavigneer/sheltie. If it isn't, stage everything and say so.
- Don't file into any other repo.
- A run with nothing new should end quickly, having changed nothing.
