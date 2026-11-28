# Notifications conditional polling: spike (#372)

Measures, on a real account, whether a conditional `GET /notifications` is
worth using to gate PR refreshes (#373). It answers: how often the answer is
`304 Not Modified`, what a 304 costs against the rate limit, what
`X-Poll-Interval` GitHub advertises, and which notification reasons show up.

Tool: `scripts/notifications-probe.mjs`. It makes requests through `gh api`, so
it uses the user's own token.

```sh
node scripts/notifications-probe.mjs once          # one poll, printed
node scripts/notifications-probe.mjs run 24        # poll at X-Poll-Interval for 24 h
node scripts/notifications-probe.mjs summary       # the tables below, from the log
```

The log is `~/.cache/sheltie-spike-372/probe.jsonl` (override with `PROBE_LOG`).
It holds notification ids, reasons, timestamps and repo names, so it stays
local and is not committed.

## What the first requests showed

Checked by hand with `gh api -i notifications` on 2026-11-28:

- **`X-Poll-Interval: 60`**. The probe waits at least this long between polls.
- **The ETag covers the whole list.** One `If-None-Match` answers "did anything
  change?" for every repo the account watches.
- **304s did not move the rate limit.** Three conditional requests in a row
  left `X-RateLimit-Used` at 35. The 200 that fetched the ETag had moved it, so
  the cost sits on the full responses, not on the 304s. This matches the docs'
  rule for authenticated requests.
- **The default list paginates at 50.** The response had a `Link` header and
  exactly 50 items. A conditional poll can still miss items past the first page
  unless the design reads the pages or narrows the query.
- **Reasons seen in the first 50 unread:** `ci_activity` 48, `subscribed` 2. The
  unread list is mostly CI runs on this account's own branches.

## Results (24 h run, started 2026-11-28 04:18 UTC)

Fill this in from `node scripts/notifications-probe.mjs summary` once the run
finishes. The go/no-go follows the table.

| Measure | Value |
| --- | --- |
| Polls (200 / 304 / errors) | pending |
| 304 rate (of answered polls) | pending |
| X-Poll-Interval values seen | pending |
| 304s that left `X-RateLimit-Used` unchanged | pending |
| 200s whose item set changed | pending |
| Largest 200 (items) and `Link` seen | pending |
| Median lag, `updated_at` to first poll | pending |
| Reasons seen (distinct notification versions) | pending |

Still unanswered: whether review-request changes appear as their own reason
(`review_requested`) for PRs the user is involved in. That needs a review
request to land during the run. The per-repo events endpoint is not measured.

## Go / no-go

pending. The question for #373 is whether a 304 rate that is high enough
justifies gating PR refreshes on the ETag, given that the first page holds
50 items and the list is mostly CI.
