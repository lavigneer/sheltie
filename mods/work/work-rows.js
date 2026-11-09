// What the Work sidebar shows, as plain data: its groups (a repo's header,
// which is also its hub's row) and their rows, at the sidebar's width, with
// the selection. work/main.js draws it (render) and writes it out (report);
// nothing here draws, so tests can check what a row shows.
//
// Tones name theme colours ("blocked", "done", "muted", "dim", "working",
// or a space status, which falls back to "accent" when the theme has none).

import { prLabel, toneKey } from "./flow.js";
import { band, RAIL } from "./sidebar.js";
import { dollars } from "./usage.js";

// Narrower than RAIL (sidebar.js), the sidebar draws a rail. Narrower than
// SHORT, a row's PR is a short word ("#7 CI failed"), its ticket status gives
// way and its step buttons take short labels; narrower than GLYPH, the PR is
// its glyph alone.
export { RAIL };
export const GLYPH = 220;
export const SHORT = 340;

// The band a width falls in: "rail", "glyph", "short" or "full" (not
// measured yet: "full").
export const fit = (width) =>
  band(width, [
    ["rail", RAIL],
    ["glyph", GLYPH],
    ["short", SHORT],
  ]);

// A repo's rail monogram: its name's first letter or digit, upper-cased.
export const monogram = (name) =>
  (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();

// How long a step's success note stays.
export const NOTE_MS = 60_000;

// Each state has its own glyph, not only its own colour.
const GLYPHS = { blocked: "!", done: "✓" };

// The row's status: a failed last step marks it (until the next step);
// without a space, a row with a PR shows the PR's glyph, so rows tell apart
// at a glance (on the rail too). `pr`: the row's (its tone already a
// theme colour). { glyph, tone, spin, tip }.
function statusOf(space, failed, pr) {
  if (failed) return { glyph: "✕", tone: "blocked", spin: false, tip: null };
  if (!space)
    return {
      glyph: pr ? pr.glyph : "○",
      tone: pr ? pr.tone : "dim",
      spin: false,
      tip: pr
        ? `${pr.text} · no space open — Enter to open`
        : "No space open — Enter to open",
    };
  if (space.status === "working")
    return { glyph: null, tone: "working", spin: true, tip: null };
  return {
    glyph: GLYPHS[space.status] ?? "●",
    tone: space.status ?? "accent",
    spin: false,
    tip: null,
  };
}

// The groups and rows shown. `input`:
//   groups     the shown groups ([{ repo, hub, worktrees }])
//   folded     repo paths folded (their hub stays, as the header)
//   width      the sidebar's, or null
//   steps      worktree path -> the last step run ({ phase, text, at })
//   confirm    the step waiting for its second click ({ id, byKey }) or null
//   picked     the row and step the keys moved to ({ path, step }) or null
//   now        Date.now()
//   spaceOf(w), stepsOf(w, space), prOf(w), ticketOf(w) (its cache entry),
//   isTicket(w), costOf(w) (in $, or null)
// Returns { span, groups: [{ repo, name, monogram, count, size, open, hub,
// worktrees }], rows (in order: what the keys move through), at, step }.
export function workView(input) {
  const span = fit(input.width);
  const narrow = span === "short" || span === "glyph";
  const now = input.now ?? Date.now();

  const rowOf = (w) => {
    const space = input.spaceOf(w);
    const last0 = input.steps.get(w.path) ?? null;
    const running = last0?.phase === "running";
    // A success note fades after a minute; a failure stays until the next step.
    const last =
      last0?.phase === "done" && now - last0.at > NOTE_MS ? null : last0;
    const entry = w.handle ? input.ticketOf(w) : null;
    const ticket = entry?.value ?? null;
    const prValue = input.prOf(w);
    const shown = span === "glyph" || span === "short" ? span : "full";
    const label = prLabel(prValue, shown);
    // `shown`: narrow, the PR shrinks to a word, then a glyph (its head),
    // rather than being cut.
    const pr = label && { ...label, tone: toneKey(label.tone), shown };
    // A branch that isn't a ticket (see isTicket) shows the branch.
    const isTicket = input.isTicket(w);
    const title = w.hub
      ? (w.branch ?? "detached")
      : isTicket
        ? w.handle.label
        : w.branch;
    const sub = ticket
      ? ticket.summary
      : isTicket
        ? entry?.state === "failed"
          ? `${w.branch} · ${w.handle.tracker.name} unreachable`
          : w.branch
        : "";
    const extras = [
      prValue?.state === "OPEN" && prValue.autoMerge ? "auto-merge" : null,
    ].filter(Boolean);
    // The row's third line: the last step's note, else these extras.
    const note = last
      ? { text: last.text, tone: last.phase === "failed" ? "blocked" : "dim" }
      : extras.length
        ? { text: extras.join(" · "), tone: "dim" }
        : null;
    const steps = running
      ? []
      : input.stepsOf(w, space).map((s) => {
          const confirming = input.confirm?.id === `${w.path}:${s.id}`;
          // A step button's label is never cut: narrow, it takes its short
          // label (and the buttons wrap).
          const name = narrow ? s.short : s.label;
          return {
            ...s,
            confirming,
            chosen: false,
            text: confirming
              ? `${name}? ${input.confirm.byKey ? "Press" : "Click"} again`
              : name,
          };
        });
    const cost = input.costOf(w);
    const costText = cost === null ? null : dollars(cost);
    // On the rail, a ticket's number tells rows apart without a hover:
    // "#141" or "PROJ-123" shows 141 or 123.
    const num =
      !w.hub && isTicket ? (w.handle.label.match(/\d+$/)?.[0] ?? null) : null;
    const tip = [
      w.hub ? `${w.repo.name} hub: ${title}` : title,
      sub,
      pr?.text,
      costText && `agents ${costText}`,
      running
        ? last.text
        : steps.length
          ? `Next: ${steps.map((s) => s.label).join(", ")}`
          : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      w,
      space,
      hub: Boolean(w.hub),
      selected: false,
      title,
      sub,
      ticket,
      // The ticket status gives way first: narrow, it's left out.
      ticketStatus: narrow ? null : (ticket?.status ?? null),
      num,
      cost,
      costText,
      pr,
      prValue,
      status: statusOf(space, last?.phase === "failed", pr),
      steps,
      last,
      note,
      // What the row's ↗ menu offers: only what applies (none for a hub).
      links: w.hub
        ? []
        : [
            prValue?.url ? { id: "pr", label: "Open PR" } : null,
            isTicket ? { id: "ticket", label: "Open ticket" } : null,
          ].filter(Boolean),
      tip,
    };
  };

  const groups = input.groups.map((g) => {
    const open = !input.folded.has(g.repo.path);
    const n = g.worktrees.length;
    return {
      repo: g.repo,
      name: g.repo.name,
      monogram: monogram(g.repo.name),
      count: `hub and ${n} worktree${n === 1 ? "" : "s"}`,
      size: String(n + 1),
      open,
      hub: rowOf({ ...g.hub, repo: g.repo }),
      // Folded, the group keeps only its header (the hub's row).
      worktrees: open
        ? g.worktrees.map((w) => rowOf({ ...w, repo: g.repo }))
        : [],
    };
  });
  const rows = groups.flatMap((g) => [g.hub, ...g.worktrees]);

  // The selected row and step: the one the keys moved to, else the focused
  // space's row, else the first.
  let at = input.picked
    ? rows.findIndex((r) => r.w.path === input.picked.path)
    : -1;
  let step = at >= 0 ? input.picked.step : 0;
  if (at < 0) {
    at = rows.findIndex((r) => r.space?.active);
    if (at < 0 && rows.length) at = 0;
    step = 0;
  }
  const n = rows[at]?.steps.length ?? 0;
  step = n ? Math.min(step, n - 1) : 0;
  if (rows[at]) {
    rows[at].selected = true;
    if (n) rows[at].steps[step].chosen = true;
  }
  return { span, groups, rows, at, step };
}
