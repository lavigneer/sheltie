# Design review: mods and layout (November 2026)

A review of the Work sidebar, Usage panel, Tickets and Projects popups and
the `sheltie` layout, from `npm run e2e:shots` on the Jira demo (Herdr
desktop 0.1.10): small, default and large windows, light and dark, zoom 1,
1.5 and 2, and the sidebar from rail to wide. Suggestions are ranked by
impact within each section; none are implemented here.

## Summary

The visual language is calm and consistent with Herdr's own chrome: one
accent, dim secondary text, colour reserved for PR state. The weak spots
are vertical space (hub rows, the fixed Usage height, the reserved status
line) and what's lost as the sidebar narrows (the rail is anonymous, the
Usage panel drops its labels before its numbers).

## Layout (`layouts/sheltie.json`)

1. **Usage is a fixed 170px and clips.** At every window size the cost
   table's second row ("7 days") is cut through the middle by the footer.
   At zoom 2 in the small window Usage takes the whole column and Work
   shows a single row. Size Usage to its content (or `weight` with a
   `max`) and give Work the priority, or let Usage collapse to its header.
2. **The Work list ends mid-row with no cue.** WEB-101's second line is cut
   by the Usage header with nothing saying the list scrolls. A fade or a
   divider at the list's bottom edge would show there's more.
3. **The sidebar's 340px default is generous for what it holds.** The wide
   (400px+) shot gains nothing but whitespace between the title and the PR
   badge; the slim (~200px) shot already loses PR state. ~280–300px keeps
   every row's badge whole on the demo.

## Work sidebar (`src/work/main.js`)

### Hierarchy and density

1. **Hub rows waste a line.** The second line is reserved on every row so
   late lookups don't shift the list (`main.js:974`), but a hub row never
   gets a ticket status, so each `main · hub` row is two lines tall with
   the second empty. Skip the reserved line for hub rows, and the list
   gains ~22px per repo.
2. **The selection ring and the active space look alike at a glance.** The
   selected row is an accent border; the active space a background fill.
   With no space open (all the shots), the selected hub row reads as
   "current". Consider a lighter selection treatment (a left bar) so the
   fill alone means "you are here".
3. **Group counts are ambiguous.** `api 1`, `customer-onboarding… 2` count
   worktrees but not the hub row shown under them. A count of the visible
   rows, or a tooltip, avoids the mismatch.

### Responsive behaviour

4. **Below ~200px the PR badge goes first.** At 160–200px `#1287 draft
   changes requested ✗ 0/1` becomes `#1…`, so the most important signal
   (red, needs attention) is the first lost. Keep the tone at any width:
   shrink to `✗ 0/1` or a coloured dot before truncating, and truncate the
   ticket summary instead.
5. **Step buttons wrap one per line at narrow widths** ("Fix CI" then
   "Address 12 comm…"), making WEB-106 four lines. Shorter labels at
   narrow widths ("Address 12") or icon+count would keep one line.
6. **The rail is anonymous.** Under 160px each row is a `○` and each repo a
   `⌄`; nothing tells `api` from `storage` without hovering. Show the
   repo's initial (or a 2-letter monogram) on the group row and the ticket
   key's number under its dot; keep the accent ring for selection.
7. **The RAIL breakpoint is a hard cliff.** Between 160 and ~190px the full
   rows are already mostly ellipses. An intermediate "compact" mode (one
   line per row: status, key, PR tone) would bridge rail and full.

### State changes

8. **Status glyphs rely on colour alone.** `●` in `t[space.status]`
   (`main.js:671`) means idle/blocked/done by hue only; only "working" has
   its own shape (the spinner). Give blocked a distinct glyph (e.g. `!` or
   a ring) for colour-blind users and for light theme, where the dim
   palette is close.
9. **"No space" and "idle space" are both quiet circles.** `○` (no space)
   vs `●` (space) is a small difference at 11px. Fine once learnt, but the
   tooltip on the full row should say "No space open — Enter to open".
10. **Loading and empty messages** (`main.js:1123`) are plain dim text at
    the top. "Loading worktrees…" could keep the previous list visible
    (stale but useful) rather than replacing it, on refresh.
11. **Failed steps** colour the note red (`main.js:793`) but the row's
    status dot is unchanged; a failed step should also mark the dot so it
    stands out when scanning collapsed groups.

## Usage panel (`src/usage/main.js`)

1. **Narrow widths drop the labels, not the dates.** At ~160px "Session"
   and "Week (all models)" vanish while `Nov 8, 9:39pm` stays, so the
   bars are unlabelled. Truncate the reset time first (or move it to a
   tooltip), keep the label.
2. **At zoom 2 the label truncates to "Ses…"** while the date keeps full
   width. Same fix.
3. **Bar colour doesn't change with risk.** 8% and 93% are the same
   accent. Shift to the warning/blocked tone past ~80% so the limit is
   noticed before it's hit.
4. **The rail shows only the session "8%"**; the tooltip explains it, but
   the week limit is never shown. Show whichever of session/week is
   higher, labelled `S`/`W`.

## Tickets popup (`src/tickets/main.js`)

1. **An empty band sits between the search box and the list.** The status
   line reserves its height so the list doesn't jump (`main.js:759`),
   which is right, but at ~40px with nothing in it it reads as a layout
   bug. Halve it, or put the status in the header's right side instead.
2. **The PR column truncates first.** `#34 changes requested ✗ 0/1` and
   `#1287 draft changes reques…` lose their tail (the ✗ and checks) in the
   default 760px popup while the title has room. Give the PR cell
   `flex_none` (or a higher min width) and let the title and repo shrink.
3. **`●` vs `·` for "has work"** is subtle, and `·` reads as a bullet, not
   "none". Use an empty space (or `○`) for "no work" so the column scans.
4. **The ticket view's title truncates on one line** (`WEB-106 Billing:
   when a customer changes plans in the middle…`). Allow two lines; it's
   the one place the full summary is shown.
5. **Repo names truncate in the ticket view** (`acme/customer-onboa…`)
   with free space to the right; the branch column could shrink instead.
6. **Keyboard hints** ("Tab mark · Ctrl+O browser · Ctrl+R reload · Esc")
   are good; while an action runs the line changes to "Working… · Esc
   stops after this step", which is clear. A spinner next to it would make
   the running state visible from the corner of the eye.

## Projects popup (`src/projects/main.js`)

1. **Paths truncate at the end**, losing the repo-specific tail
   (`…/herdr-demo-e2…`). Truncate the start instead (`…/ws/customer-…`),
   or show the path relative to the common parent of all projects.
2. **Name column width follows the longest name**, pushing every path
   right. Cap the name column (~40%) and truncate.
3. **"open" for an already-open project** is dim text at the far right;
   matching the Tickets popup's `●` keeps the two popups consistent.

## Cross-cutting

- **Dark theme** keeps the contrast of PR tones (red/blue) but the dim
  text on the sidebar is close to the 4.5:1 floor at 11px; check
  `t.dim` against `t.chrome` in both themes.
- **Font sizes** are 11, 11.5, 12 and 13px; settling on two (11, 13)
  would make the hierarchy crisper.
- **Shots coverage**: add an e2e shot of a space that is *working* and one
  *blocked*, and of a failed step, so the state treatments above are
  reviewed visually and not only by reading code; today every row in the
  shots is `○` (no space).
