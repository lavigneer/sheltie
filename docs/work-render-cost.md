# Work sidebar render cost

Findings for #354: how long the Work sidebar's renders take in Herdr, from the
data the app already records. The cost of drawing in gpui (the layout and paint
that the test stubs don't cover) is still unmeasured; see "Not measured yet".

## Where the numbers come from

- **`work.report`** (`herdr-app do work.report`, also collected by
  `diagnostics.sh`): the in-memory render stats since the Work mod last loaded
  (`src/renders.js`). It has a count, a mean, the five slowest renders (with
  `viewMs`, `buildMs`, `rows`, `trigger`) and a count per trigger. It has no
  percentiles.
- **Slow-render records** in `<app home>/sheltie-diagnostics/`: one JSON file per
  render over `SLOW_MS = 100`. These persist across app restarts.

## Live report (2026-11-26, 23:15 CST)

Captured from the running window with `herdr-app do work.report`. The window
runs the mod installed on 2026-11-26 at 21:17, which is **before #334**
(`c058a18`). Its renders have no `hostMs` or `rebuilt` fields, and `mods/work`
in this checkout does. The window showed 7 rows.

| Measure | Value |
| --- | --- |
| Renders since the mod loaded | 1116 |
| Mean | 4.0 ms |
| Slowest | 49 ms (trigger `host`, 6 rows) |
| By trigger | host 674, lookup 98, hover 80, scan 87, timer 54, step 70, costs 41, menu 11, command 1 |

No render in this session reached `SLOW_MS` (100 ms).

## Recorded slow renders

There are 10 records: 9 from 2026-11-18 (CST) and 1 from 2026-11-26 21:17 CST.
All were written by builds from before #334, when the render could only be
split into view and build. Sorted by total time:

| Total ms | Trigger | viewMs | buildMs | Rows |
| ---: | --- | ---: | ---: | ---: |
| 805 | scan | 685 | 120 | 2 |
| 540 | host | 409 | 131 | 0 |
| 262 | scan | 225 | 37 | 2 |
| 246 | scan | 86 | 160 | 6 |
| 174 | host | 150 | 24 | 2 |
| 150 | host | 110 | 40 | 0 |
| 120 | host | 36 | 84 | 6 |
| 111 | timer | 87 | 24 | 2 |
| 110 | costs | 37 | 73 | 0 |
| 109 | host | 109 | 0 | 6 |

What the records show:

- The slowest is 805 ms, and 3 of the 10 are 262 ms or more.
- 3 are zero-row renders (540, 150 and 110 ms). Most of their time is
  `viewMs`, the reads of Herdr's own state. That fits #334's reading: the cost
  sits outside our view and build code. These records have no `hostMs`, so it
  can't be confirmed from them.
- None of the 9 records from 2026-11-18 has a counterpart in the live report
  above, which covers the window's current session.
- The rows are at most 6. The issue's target is 40 repos and about 300 tickets.

## Decision

No render fix is justified by this data. The pre-#334 build in the live window shows a
mean of 4 ms and a worst case of 49 ms (6 rows in that render). The old 100 ms+ spikes were not reproduced.
The one open question is the zero-row cost in the old records, which only the
split from #334 can answer.

## Not measured yet

1. **Profile at scale.** Neither `herdr-app` nor `hc` has a profiling command.
   A profile at 40 repos and about 300 tickets would need a Time Profiler or
   Instruments trace on the person's Mac, with that fixture built in their
   window. The stub tests can't stand in for it: #334 measured the JS side at
   about 0.02 ms per render, and the question is about gpui.
2. **Post-#334 data.** The window needs `./install.sh` so it runs `mods/work`
   from this checkout. Then the slow-render records will carry `hostMs` and
   `rebuilt`.
3. **Distribution.** `work.report` has no histogram, so it can't give p50 or
   p95. A bucketed count in `RenderStats` would make the report answer the
   issue's "Done when" directly.

## Follow-ups

- Reinstall the mods, then check `work.report` and the slow-render records for
  a few days of normal use.
- If the histogram is wanted: a small change to `src/renders.js`, with `mods/`
  rebuilt.
- If a render fix is ever needed, file it with the profile from item 1 as the
  evidence.

## How to repeat this

```sh
herdr-app do work.report           # writes <app home>/work-report.json
ls <app home>/sheltie-diagnostics/ # slow-render records (>= 100 ms)
./diagnostics.sh --out -           # everything above, scrubbed
```

`<app home>` is `~/.config/herdr-app` unless `HERDR_APP_HOME` is set. The
records and the report can name repos, branches and tickets, so read them
before sharing.
