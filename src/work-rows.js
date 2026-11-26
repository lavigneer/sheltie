// What the Work sidebar shows, as plain data: its groups (a repo's header,
// which is also its hub's row) and their rows, at the sidebar's width, with
// the selection. work/main.js draws it (render) and writes it out (report);
// nothing here draws, so tests can check what a row shows.
//
// Tones name theme colours ("blocked", "done", "muted", "dim", "working",
// or a space status, which falls back to "accent" when the theme has none).

import {
  LADDER,
  prLabel,
  STEP,
  stageOf,
  stepState,
  succeeded,
  toneKey,
} from "./flow.js";
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
export const fit = (/** @type {any} */ width) =>
  band(width, [
    ["rail", RAIL],
    ["glyph", GLYPH],
    ["short", SHORT],
  ]);

// A repo's rail monogram: its name's first letter or digit, upper-cased.
export const monogram = (/** @type {any} */ name) =>
  (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();

// A stage group's key in the folded set (repo groups use the repo's path).
export const stageKey = (/** @type {any} */ stage) => `stage:${stage}`;

// How long a step's success note stays.
export const NOTE_MS = 60_000;

// Each state has its own glyph, not only its own colour.
const GLYPHS = { blocked: "!", done: "✓" };

// The row's status: a failed last step marks it (until the next step);
// without a space, a row with a PR shows the PR's glyph, so rows tell apart
// at a glance (on the rail too). `pr`: the row's (its tone already a
// theme colour). { glyph, tone, spin, tip }.
function statusOf(
  /** @type {any} */ space,
  /** @type {any} */ failed,
  /** @type {any} */ pr,
) {
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
    glyph: /** @type {Record<string, string>} */ (GLYPHS)[space.status] ?? "●",
    tone: space.status ?? "accent",
    spin: false,
    tip: null,
  };
}

// The groups and rows shown. `input`:
//   groups     the shown groups ([{ repo, hub, worktrees }])
//   by         "repo" (the default) or "stage": one group per PR stage
//              (LADDER, in its order), each row naming its repo; the hubs with a space
//              come first, in a "Hubs" group of their own
//   folded     group keys folded: repo paths (their hub stays, as the
//              header) or stageKey()s
//   cap        by repo, the most worktrees a group shows (0 or absent: all)
//   expanded   repo paths whose "+k more" was clicked: they show them all
//   width      the sidebar's, or null
//   steps      worktree path -> the last step run ({ phase, text, at })
//   confirm    the step waiting for its second click ({ id, byKey }) or null
//              (its byKey: the look of the wait)
//   armed(id)  whether step id is waiting for its second click (Nav.armed)
//   picked     the row and step the keys moved to ({ path, step }) or null
//   now        Date.now()
//   spaceOf(w), stepsOf(w, space), prOf(w), stackOf(w) (the ticket's other
//   PRs in the row's repo; optional), ticketOf(w) (its cache entry),
//   isTicket(w), costOf(w) (in $, or null)
// Returns { span, by, groups: [{ key, repo, name, monogram, count, size,
// open, hub, worktrees, more, fewer }] (more: how many worktrees the cap
// hides; fewer: expanded past the cap) (by stage: repo and hub are null), rows (in order: what the keys move through), at, step }.
export function workView(/** @type {any} */ input) {
  const span = fit(input.width);
  const narrow = span === "short" || span === "glyph";
  const now = input.now ?? Date.now();

  const by = input.by === "stage" ? "stage" : "repo";
  const rowOf = (/** @type {any} */ w) => {
    const space = input.spaceOf(w);
    const last0 = input.steps.get(w.path) ?? null;
    const state = stepState(last0);
    const running = state === STEP.RUNNING;
    // A success note fades after a minute; a failure stays until the next step.
    const last = succeeded(state) && now - last0.at > NOTE_MS ? null : last0;
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
    // By stage, a hub's row has no repo header above it: it's named for
    // its repo, its branch below.
    const hubStage = w.hub && by === "stage";
    const title = w.hub
      ? hubStage
        ? w.repo.name
        : (w.branch ?? "detached")
      : isTicket
        ? w.handle.label
        : w.branch;
    const sub0 = ticket
      ? ticket.summary
      : isTicket
        ? entry?.state === "failed"
          ? `${w.branch} · ${w.handle.tracker.name} unreachable`
          : w.branch
        : "";
    // By stage, rows of every repo mix: each names its own.
    const sub = hubStage
      ? (w.branch ?? "detached")
      : by === "stage" && !w.hub
        ? [w.repo.name, sub0].filter(Boolean).join(" · ")
        : sub0;
    // The ticket's other PRs here (a stack): each a sub-item under the row
    // (stackItem), selectable like a row; its own key, `${path}#${number}`.
    // Numbered by its place in the stack (the row's own PR included), so
    // "2/3" is the second of three PRs in order of number.
    const others = input.stackOf?.(w) ?? [];
    const order = [prValue, ...others]
      .filter(Boolean)
      .map((p) => p.number)
      .sort((a, b) => a - b);
    const stack = others.map((/** @type {any} */ p) =>
      stackItem(w, p, span, order.indexOf(p.number) + 1, order.length),
    );
    const extras =
      prValue?.state === "OPEN" && prValue.autoMerge ? ["auto-merge"] : [];
    // The row's third line: the last step's note, else these extras.
    const note = last
      ? { text: last.text, tone: state === STEP.FAILED ? "blocked" : "dim" }
      : extras.length
        ? { text: extras.join(" · "), tone: "dim" }
        : null;
    const steps = running
      ? []
      : input
          .stepsOf(w, space)
          .map((/** @type {any} */ s, /** @type {any} */ i) => {
            const confirming = input.armed(`${w.path}:${s.id}`);
            // A step button's label is never cut: narrow, it takes its short
            // label (and the buttons wrap).
            const name = narrow ? s.short : s.label;
            return {
              ...s,
              confirming,
              // Steps come most pressing first (nextSteps): the first is the
              // row's next step, drawn solid; the rest are quiet.
              primary: i === 0,
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
      stack.length &&
        `also ${stack.map((/** @type {any} */ p) => p.head).join(" · ")}`,
      costText && `agents ${costText}`,
      running
        ? last.text
        : steps.length
          ? `Next: ${steps.map((/** @type {any} */ s) => s.label).join(", ")}`
          : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      key: w.path,
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
      stack,
      status: statusOf(space, state === STEP.FAILED, pr),
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

  const groups =
    by === "stage" ? stageGroups(input, rowOf) : repoGroups(input, rowOf);
  // What the keys move through: each row, then its stack's sub-items.
  const rows = groups.flatMap((/** @type {any} */ g) =>
    (g.hub ? [g.hub] : []).concat(g.worktrees).flatMap((r) => [r, ...r.stack]),
  );

  // The selected row and step: the one the keys moved to, else the focused
  // space's row, else the first.
  let at = input.picked
    ? rows.findIndex((/** @type {any} */ r) => r.key === input.picked.path)
    : -1;
  let step = at >= 0 ? input.picked.step : 0;
  if (at < 0) {
    at = rows.findIndex((/** @type {any} */ r) => r.space?.active);
    if (at < 0 && rows.length) at = 0;
    step = 0;
  }
  const n = rows[at]?.steps.length ?? 0;
  step = n ? Math.min(step, n - 1) : 0;
  if (rows[at]) {
    rows[at].selected = true;
    if (n) rows[at].steps[step].chosen = true;
  }
  return { span, by, groups, rows, at, step };
}

// A stacked PR `p` of row `w`'s ticket, as a sub-item under it: one line
// (its stack position `at` of `of`, number, state, title or branch), no
// steps, no space of its own; activating it opens the PR. Merged or closed:
// dimmed.
function stackItem(
  /** @type {any} */ w,
  /** @type {any} */ p,
  /** @type {any} */ span,
  /** @type {any} */ at,
  /** @type {any} */ of,
) {
  const label = /** @type {NonNullable<ReturnType<typeof prLabel>>} */ (
    prLabel(p, "short")
  );
  const done = p.state === "MERGED" || p.state === "CLOSED";
  const title = p.title || p.branch || "";
  const place = `${at}/${of}`;
  return {
    key: `${w.path}#${p.number}`,
    stacked: true,
    w,
    number: p.number,
    state: p.state,
    url: p.url ?? null,
    title,
    ...label,
    // At its narrowest, the state's glyph; else "2/3 #14 draft".
    shown:
      span === "glyph" || span === "rail"
        ? label.glyph
        : `${place} ${label.head}`,
    tone: done ? "dim" : toneKey(label.tone),
    dim: done,
    selected: false,
    steps: [],
    tip:
      [`${place} ${label.text}`, title].filter(Boolean).join(" · ") +
      " — Enter to open",
  };
}

// The worktrees a repo group shows under a cap of `cap`: the `cap` most
// recently changed (`at`), and any whose space is focused, in their order.
export function capped(
  /** @type {any} */ worktrees,
  /** @type {any} */ cap,
  /** @type {any} */ isActive,
) {
  if (!cap || worktrees.length <= cap) return worktrees;
  const recent = new Set(
    [...worktrees].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, cap),
  );
  return worktrees.filter(
    (/** @type {any} */ w) => recent.has(w) || isActive(w),
  );
}

// One group per repo, headed by its hub's row.
function repoGroups(/** @type {any} */ input, /** @type {any} */ rowOf) {
  return input.groups.map((/** @type {any} */ g) => {
    const open = !input.folded.has(g.repo.path);
    const n = g.worktrees.length;
    const cappedTo = capped(
      g.worktrees,
      input.cap ?? 0,
      (/** @type {any} */ w) =>
        input.spaceOf({ ...w, repo: g.repo })?.active ?? false,
    );
    const expanded = input.expanded?.has(g.repo.path) ?? false;
    const shown = expanded ? g.worktrees : cappedTo;
    return {
      key: g.repo.path,
      repo: g.repo,
      name: g.repo.name,
      monogram: monogram(g.repo.name),
      count: `hub and ${n} worktree${n === 1 ? "" : "s"}`,
      size: String(n + 1),
      open,
      hub: rowOf({ ...g.hub, repo: g.repo }),
      // Folded, the group keeps only its header (the hub's row).
      worktrees: open
        ? shown.map((/** @type {any} */ w) => rowOf({ ...w, repo: g.repo }))
        : [],
      more: open ? n - shown.length : 0,
      // Expanded past a cap that would hide some: it offers "Show fewer".
      fewer: open && expanded && cappedTo.length < n,
    };
  });
}

// One group per stage with any rows, in the flow's order (LADDER), after the
// hubs that have a space. A stage group has no hub: its header is a label.
function stageGroups(/** @type {any} */ input, /** @type {any} */ rowOf) {
  const hubs = [];
  /** @type {Record<string, any[]>} */
  const by = Object.fromEntries(Object.keys(LADDER).map((id) => [id, []]));
  for (const g of input.groups) {
    const hub = { ...g.hub, repo: g.repo };
    if (input.spaceOf(hub)) hubs.push(hub);
    for (const w0 of g.worktrees) {
      const w = { ...w0, repo: g.repo };
      by[stageOf(input.prOf(w))].push(w);
    }
  }
  const group = (
    /** @type {any} */ key,
    /** @type {any} */ name,
    /** @type {any} */ ws,
    /** @type {any} */ noun,
  ) => {
    const open = !input.folded.has(key);
    const n = ws.length;
    return {
      key,
      repo: null,
      name,
      monogram: monogram(name),
      count: `${n} ${noun}${n === 1 ? "" : "s"}`,
      size: String(n),
      open,
      hub: null,
      worktrees: open ? ws.map(rowOf) : [],
      more: 0,
      fewer: false,
    };
  };
  const out = [];
  if (hubs.length) out.push(group(stageKey("hubs"), "Hubs", hubs, "hub"));
  for (const [id, { name }] of Object.entries(LADDER)) {
    const ws = by[id];
    if (ws.length) out.push(group(stageKey(id), name, ws, "worktree"));
  }
  return out;
}
