// Spike for #372: how often a conditional GET of the Notifications endpoint
// returns 304, what it costs against the rate limit, and which reasons
// (ci_activity, review_requested, ...) show up on a real account.
//
//   node scripts/notifications-probe.mjs once            one poll, printed
//   node scripts/notifications-probe.mjs run [hours]     poll at X-Poll-Interval (default 24h)
//   node scripts/notifications-probe.mjs summary         tables from the log
//
// Every poll is appended as one JSON line to the log (default
// ~/.cache/sheltie-spike-372/probe.jsonl, override with PROBE_LOG). The log holds
// notification ids, reasons, timestamps and repo names: it stays on this machine
// and is not committed. Only the summary goes into docs/notifications-poll-spike.md.
//
// Requests go through `gh api`, so they use the user's own token. A 304 is
// only free against the rate limit for an authenticated request; the summary
// checks that from X-RateLimit-Used.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOG =
  process.env.PROBE_LOG ??
  join(homedir(), ".cache", "sheltie-spike-372", "probe.jsonl");
const MIN_INTERVAL_S = 60;

/**
 * One conditional GET. Returns the status, the headers we care about, and the
 * body's items (only for 200). Never throws: a failed call is recorded as an error.
 * @param {string | null} etag
 */
export function poll(etag) {
  const args = ["api", "-i"];
  if (etag) args.push("-H", `If-None-Match: ${etag}`);
  args.push("notifications");
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 });
  const out = r.stdout ?? "";
  const split = out.search(/\r?\n\r?\n/);
  const headText = split === -1 ? out : out.slice(0, split);
  const bodyText =
    split === -1 ? "" : out.slice(split).replace(/^\r?\n\r?\n/, "");
  const status = Number(/^HTTP\/\S+ (\d{3})/.exec(headText)?.[1] ?? NaN);
  /** @type {Record<string, string>} */
  const h = {};
  for (const line of headText.split(/\r?\n/).slice(1)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) h[m[1].toLowerCase()] = m[2].trim();
  }
  const base = {
    at: new Date().toISOString(),
    status: Number.isNaN(status) ? null : status,
    sentEtag: etag,
    etag: h.etag ?? null,
    pollInterval: h["x-poll-interval"] ? Number(h["x-poll-interval"]) : null,
    used: h["x-ratelimit-used"] ? Number(h["x-ratelimit-used"]) : null,
    remaining: h["x-ratelimit-remaining"]
      ? Number(h["x-ratelimit-remaining"])
      : null,
    lastModified: h["last-modified"] ?? null,
    paginated: "link" in h,
    error: r.status === 0 || Number.isNaN(status) ? firstLine(r.stderr) : null,
  };
  if (base.status !== 200) return { ...base, items: [] };
  let body = [];
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { ...base, error: "200 with an unparsable body", items: [] };
  }
  const items = body.map((/** @type {any} */ n) => ({
    id: n.id,
    reason: n.reason,
    updated_at: n.updated_at,
    subjectType: n.subject?.type ?? null,
    repo: n.repository?.full_name ?? null,
  }));
  return { ...base, items };
}

function firstLine(/** @type {string | undefined} */ s) {
  return (s ?? "").trim().split("\n")[0] || null;
}

function append(/** @type {object} */ rec) {
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, JSON.stringify(rec) + "\n");
}

function readLog() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function run(hours) {
  const until = Date.now() + hours * 3_600_000;
  // Resume from the last recorded ETag, so a restarted run keeps the 304s going.
  const prev = readLog().at(-1);
  let etag = prev?.etag ?? null;
  let interval = MIN_INTERVAL_S;
  while (Date.now() < until) {
    const rec = poll(etag);
    append(rec);
    if (rec.etag) etag = rec.etag;
    if (rec.pollInterval) interval = Math.max(MIN_INTERVAL_S, rec.pollInterval);
    console.log(
      `${rec.at} ${rec.status ?? "err"} used=${rec.used} items=${rec.items.length}${rec.error ? " error=" + rec.error : ""}`,
    );
    await sleep(interval * 1000);
  }
}

function summary() {
  const recs = readLog();
  const ok = recs.filter((r) => r.status === 200 || r.status === 304);
  const r200 = recs.filter((r) => r.status === 200);
  const r304 = recs.filter((r) => r.status === 304);
  const errors = recs.length - ok.length;
  const first = recs[0]?.at ?? "-";
  const last = recs.at(-1)?.at ?? "-";
  const intervals = [...new Set(recs.map((r) => r.pollInterval))];

  // 304 cost: did X-RateLimit-Used stay the same from the previous poll?
  // Other gh use on this machine between polls also moves it, so this is an
  // upper bound on what a 304 costs.
  let free304 = 0;
  let counted304 = 0;
  for (let i = 1; i < recs.length; i++) {
    if (recs[i].status !== 304 || recs[i - 1].used == null) continue;
    if (recs[i].used === recs[i - 1].used) free304++;
    else counted304++;
  }

  // Reasons, counted once per (id, updated_at): each notification as it stood.
  /** @type {Map<string, any>} */
  const seen = new Map();
  for (const r of r200)
    for (const it of r.items)
      if (!seen.has(`${it.id}@${it.updated_at}`))
        seen.set(`${it.id}@${it.updated_at}`, { ...it, firstSeen: r.at });
  /** @type {Record<string, number>} */
  const reasons = {};
  for (const it of seen.values())
    reasons[it.reason] = (reasons[it.reason] ?? 0) + 1;

  // Changes: a 200 whose item set differs from the previous 200's.
  let changed200 = 0;
  let unchanged200 = 0;
  for (let i = 1; i < r200.length; i++) {
    const a = r200[i - 1].items
      .map((/** @type {any} */ x) => `${x.id}@${x.updated_at}`)
      .sort()
      .join();
    const b = r200[i].items
      .map((/** @type {any} */ x) => `${x.id}@${x.updated_at}`)
      .sort()
      .join();
    if (a === b) unchanged200++;
    else changed200++;
  }

  // Lag: updated_at to the first poll that saw it (only for items seen after the first 200).
  const firstAt = r200[0]?.at;
  const lags = [...seen.values()]
    .filter((it) => it.firstSeen !== firstAt)
    .map((it) => (Date.parse(it.firstSeen) - Date.parse(it.updated_at)) / 1000)
    .filter((s) => s >= 0)
    .sort((a, b) => a - b);
  const median = lags.length ? lags[Math.floor(lags.length / 2)] : null;

  const maxItems = Math.max(0, ...r200.map((r) => r.items.length));
  const paginated = recs.some((r) => r.paginated);

  console.log(`# Notifications poll probe summary`);
  console.log(`window: ${first} .. ${last}`);
  console.log(
    `polls: ${recs.length} (200: ${r200.length}, 304: ${r304.length}, errors: ${errors})`,
  );
  console.log(
    `304 rate (of answered polls): ${ok.length ? ((100 * r304.length) / ok.length).toFixed(1) : "-"}%`,
  );
  console.log(`X-Poll-Interval values: ${intervals.join(", ") || "-"}`);
  console.log(
    `304s that left X-RateLimit-Used unchanged: ${free304} of ${free304 + counted304}`,
  );
  console.log(
    `200s with an item set changed from the previous 200: ${changed200} (unchanged: ${unchanged200})`,
  );
  console.log(
    `largest 200 (items): ${maxItems}; Link header seen: ${paginated}`,
  );
  console.log(
    `median lag, updated_at to first poll: ${median == null ? "-" : median.toFixed(0) + " s"} (n=${lags.length})`,
  );
  console.log(`\n## Reasons (distinct notification versions)`);
  for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1]))
    console.log(`- ${reason}: ${n}`);
  if (!Object.keys(reasons).length) console.log("- none yet");
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "once") {
  const rec = poll(null);
  console.log(JSON.stringify({ ...rec, items: rec.items.length }, null, 2));
  append(rec);
} else if (cmd === "run") {
  await run(Number(arg ?? 24));
} else if (cmd === "summary") {
  summary();
} else {
  console.error("usage: notifications-probe.mjs once | run [hours] | summary");
  process.exit(2);
}
