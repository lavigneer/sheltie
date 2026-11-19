// What the Reviews sidebar shows, as plain data: a row per PR awaiting your
// review (oldest request first), then one per reviewed PR whose worktree is
// still here. reviews/main.js draws it; nothing here draws, so tests can
// check a row's title, sub-line and age tone.
//
// A row is two lines: the title with the age at the right (the row's one
// loud element, toned by the wait), then a dim sub-line (repo #n · author ·
// +/−). Narrow, the sub-line's items drop out (size, then author) rather
// than being cut; the title has its line to itself but for the age.

import { band, RAIL } from "./sidebar.js";

export { RAIL };
// Narrower than SHORT, the sub-line drops the size; narrower than TIGHT,
// the author too.
export const TIGHT = 220;
export const SHORT = 300;

// The band a width falls in: "rail", "tight", "short" or "full".
export const fit = (width) =>
  band(width, [
    ["rail", RAIL],
    ["tight", TIGHT],
    ["short", SHORT],
  ]);

const HOUR = 3_600_000;
// Waiting this long or more, the age turns "working", then "blocked".
export const WARN_MS = 4 * HOUR;
export const LATE_MS = 24 * HOUR;

// "3d", "5h", "12m": how long ago `iso` was.
export function age(iso, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  return m >= 1440
    ? `${Math.floor(m / 1440)}d`
    : m >= 60
      ? `${Math.floor(m / 60)}h`
      : `${m}m`;
}

// The theme colour for a wait of `ms`: "dim", "working", then "blocked".
export const waitTone = (ms) =>
  ms >= LATE_MS ? "blocked" : ms >= WARN_MS ? "working" : "dim";

// `input`: queue (reviewQueue's PRs), reviewed (review worktrees whose PR
// left the queue), worktreeOf(pr), width, now. Returns { span, rows }; a
// row: { key, pr, reviewed, title, sub, age, ageTone, done, tip }.
export function reviewsView(input) {
  const span = fit(input.width);
  const now = input.now ?? Date.now();
  const subOf = (r, author) =>
    [
      `${r.slug.split("/")[1]} #${r.number}`,
      span === "tight" ? null : author,
      span === "full" && r.additions != null
        ? `+${r.additions} −${r.deletions}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");

  const queued = input.queue.map((r) => {
    const waited = r.requestedAt ? now - Date.parse(r.requestedAt) : null;
    return {
      key: `${r.slug}-${r.number}`,
      pr: r,
      reviewed: false,
      title: r.title,
      sub: subOf(r, r.author),
      age: waited === null ? "" : age(r.requestedAt, now),
      ageTone: waited === null ? "dim" : waitTone(waited),
      done: Boolean(input.worktreeOf(r)),
      tip: `${r.slug}#${r.number} by ${r.author}\n${r.title}\nClick to start reviewing`,
    };
  });
  // Reviewed: drawn quieter, "reviewed" where the age goes.
  const reviewed = input.reviewed.map((w) => {
    const pr = {
      slug: w.slug,
      number: w.number,
      url: w.url || `https://github.com/${w.slug}/pull/${w.number}`,
      title: w.title || "(reviewed)",
    };
    return {
      key: `${w.slug}-${w.number}`,
      pr,
      reviewed: true,
      title: pr.title,
      sub: subOf(pr, null),
      age: "reviewed",
      ageTone: "dim",
      done: true,
      tip: `${w.slug}#${w.number} (reviewed)\n${pr.title}\nClick to open its space`,
    };
  });
  return { span, rows: queued.concat(reviewed) };
}
