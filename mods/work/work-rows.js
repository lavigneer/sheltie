// What the Work sidebar shows: its groups (a repo's header, which is also its
// hub's row) and their rows, at the sidebar's width, with the selection, as
// plain data (workView, and capped). The builders after it draw them: each
// turns a group, row or stacked PR into gpui elements (groupEl, rowEl,
// subRowEl, headerEl, bodyEl...). A builder takes its data and `ui` (see
// "Drawing") and reads no View state, so tests can check a layout without a
// View (tests/work-layout.test.mjs). work/main.js calls them in render (draw)
// and writes the data out in report.
//
// Tones name theme colours ("blocked", "done", "muted", "dim", "working",
// or a space status, which falls back to "accent" when the theme has none).

import { h_flex, Popover, v_flex } from "gpui-base";
import { div, svg } from "gpui-kit";
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

// A row's ↗ button, its width (the menu's trigger).
export const LINKS_W = 18;

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

// ---- Drawing ----------------------------------------------------------------
//
// The builders below return gpui elements. Each takes its data and `ui`, which
// holds what a draw needs besides the data:
//   t          the theme
//   rail       whether the sidebar is a rail (its width is under RAIL)
//   hovered    the path of the row under the pointer, or null
//   linksOpen  the path of the row whose ↗ menu is open, or null
// and the actions a click, hover or menu calls (the View's; see
// Work.sidebarActions): open(w), openStacked(p), step(cx, w, s),
// follow(cx, w, id), hoverRow(cx, w, hovered), openLinks(cx, w, open),
// closeLinks(cx), expand(cx, key), fold(cx, g), toggleGroupBy(cx),
// refresh(cx), newWork().

/** @type {(t: any, name: any) => any} */
const toneOf = (t, name) => t[name] ?? t.accent;

// A header or row button: an id, a label, a tooltip, and what a click does
// (the click doesn't reach the row behind it).
function iconButton(
  /** @type {any} */ ui,
  /** @type {any} */ name,
  /** @type {any} */ label,
  /** @type {any} */ tip,
  /** @type {any} */ onClick,
) {
  const { t } = ui;
  return div()
    .id(`work-${name}`)
    .h(20)
    .px(5)
    .flex()
    .items_center()
    .rounded(5)
    .text_size(12.5)
    .text_color(t.dim)
    .cursor_pointer()
    .hover((/** @type {any} */ s) => s.bg(t.hover).text_color(t.foreground))
    .tooltip(tip)
    .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => {
      cx.stop_propagation();
      onClick(cx);
    })
    .child(label);
}

// The header: on a rail, only "+"; else "Work" with the grouping, refresh and
// "+" buttons. `by`: the grouping shown; `refreshing`: ↻ spins while a
// refresh asked for by hand (git, then tickets and PRs) runs.
export function headerEl(
  /** @type {any} */ ui,
  /** @type {any} */ by,
  /** @type {any} */ refreshing,
) {
  const { t, rail } = ui;
  if (rail)
    return h_flex()
      .h(30)
      .flex_none()
      .justify_center()
      .items_center()
      .child(iconButton(ui, "new", "+", "New work (tickets)", ui.newWork));
  const refreshLabel = refreshing
    ? svg("mods/workspace-chrome/spinner.svg").size(11).spin(900)
    : "↻";
  return h_flex()
    .h(30)
    .flex_none()
    .px(12)
    .gap(4)
    .items_center()
    .child(
      div()
        .flex_1()
        .min_w(0)
        .truncate()
        .text_size(11)
        .font_semibold()
        .text_color(t.dim)
        .child("Work"),
    )
    .child(
      iconButton(
        ui,
        "group",
        "▤",
        by === "stage" ? "Group by repo" : "Group by stage",
        ui.toggleGroupBy,
      ),
    )
    .child(
      iconButton(
        ui,
        "refresh",
        refreshLabel,
        refreshing ? "Refreshing…" : "Refresh now",
        ui.refresh,
      ),
    )
    .child(iconButton(ui, "new", "+", "New work (tickets)", ui.newWork));
}

// A row's status glyph (or spinner), as work-rows.js decided it.
function statusEl(/** @type {any} */ ui, /** @type {any} */ r) {
  const st = r.status;
  if (st.spin)
    return svg("mods/workspace-chrome/spinner.svg")
      .size(11)
      .flex_none()
      .text_color(toneOf(ui.t, st.tone))
      .spin(900);
  const el = div().w(12).flex_none().text_color(toneOf(ui.t, st.tone));
  return (
    st.tip ? el.id(`work-nospace-${r.w.path}`).tooltip(st.tip) : el
  ).child(st.glyph);
}

// A step button. The row's next step (primary) is the one solid thing in
// the sidebar: accent fill, background-coloured text. Later steps are
// quiet accent text. Picked: an accent outline; confirming: blocked.
function stepButton(
  /** @type {any} */ ui,
  /** @type {any} */ r,
  /** @type {any} */ s,
) {
  const { t } = ui;
  const solid = s.primary && !s.confirming;
  const ink = s.confirming ? t.blocked : solid ? t.background : t.accent;
  return div()
    .id(`work-step-${r.w.path}-${s.id}`)
    .flex_none()
    .h(18)
    .px(6)
    .flex()
    .items_center()
    .rounded(5)
    .bg(solid ? t.accent : s.confirming ? t.hover : "#00000000")
    .border_1()
    .border_color(
      s.confirming
        ? t.blocked
        : s.chosen
          ? solid
            ? t.foreground
            : t.accent
          : "#00000000",
    )
    .text_size(11)
    .when(solid, (/** @type {any} */ el) => el.font_semibold())
    .text_color(ink)
    .cursor_pointer()
    .hover((/** @type {any} */ st) =>
      solid ? st.bg(t.foreground) : st.bg(t.hover).text_color(ink),
    )
    .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => {
      cx.stop_propagation();
      ui.step(cx, r.w, s);
    })
    .child(s.text);
}

// A row's ↗ menu: a popover of what it opens in the browser (the row's links).
// It keeps its place while hidden, so showing it moves nothing.
function linksMenu(
  /** @type {any} */ ui,
  /** @type {any} */ w,
  /** @type {any} */ links,
) {
  const { t } = ui;
  return Popover.new(`work-links-${w.path}`)
    .anchor("top_right")
    .open(ui.linksOpen === w.path)
    .on_open_change((/** @type {any} */ open, /** @type {any} */ cx) =>
      ui.openLinks(cx, w, open),
    )
    .trigger(
      div()
        .id(`work-links-button-${w.path}`)
        .w(LINKS_W)
        .h(18)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(5)
        .text_size(11)
        .text_color(ui.linksOpen === w.path ? t.foreground : t.dim)
        .cursor_pointer()
        .hover((/** @type {any} */ s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Open in the browser")
        .on_click((/** @type {any} */ _e, /** @type {any} */ cx) =>
          cx.stop_propagation(),
        )
        .child("↗"),
    )
    .content(
      v_flex()
        .p(4)
        .min_w(120)
        .rounded(7)
        .border_1()
        .border_color(t.border ?? t.dim)
        .bg(t.popover)
        .children(
          links.map((/** @type {any} */ l) =>
            div()
              .id(`work-open-${l.id}-${w.path}`)
              .h(24)
              .px(8)
              .flex()
              .items_center()
              .rounded(5)
              .text_size(12.5)
              .text_color(t.foreground)
              .cursor_pointer()
              .hover((/** @type {any} */ s) => s.bg(t.hover))
              .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => {
                cx.stop_propagation();
                ui.closeLinks(cx);
                ui.follow(cx, w, l.id);
              })
              .child(l.label),
          ),
        ),
    );
}

// The rail: a row is its status, and a hover says the rest. Clicks and
// keys work as in the full rows.
function dotEl(/** @type {any} */ ui, /** @type {any} */ r) {
  const { t } = ui;
  const { w, space, pr, num } = r;
  // With a space, the dot is the agent's: the PR's glyph goes by the
  // number.
  const prGlyph = Boolean(space && pr);
  return h_flex()
    .id(`work-${w.path}`)
    .mx(4)
    .min_h(24)
    .py(2)
    .justify_center()
    .items_center()
    .rounded(6)
    .border_l_2()
    .border_color(r.selected ? t.accent : "#00000000")
    .cursor_pointer()
    .when(Boolean(space?.active), (/** @type {any} */ el) =>
      el.bg(t.selected ?? t.hover),
    )
    .hover((/** @type {any} */ s) => s.bg(t.hover))
    .tooltip(r.tip)
    .on_click(() => ui.open(w))
    .child(
      v_flex()
        .items_center()
        .child(statusEl(ui, r))
        .when(Boolean(num) || prGlyph, (/** @type {any} */ el) =>
          el.child(
            h_flex()
              .gap(2)
              .text_size(9)
              .when(Boolean(num), (/** @type {any} */ e) =>
                e.child(div().text_color(t.dim).child(num)),
              )
              .when(prGlyph, (/** @type {any} */ e) =>
                e.child(div().text_color(toneOf(t, pr.tone)).child(pr.glyph)),
              ),
          ),
        ),
    );
}

// A worktree's row: its status, title and PR on the first line; its sub line
// (ticket summary, status, cost), its steps and note below.
export function rowEl(/** @type {any} */ ui, /** @type {any} */ r) {
  const { t } = ui;
  const { w, space, pr, steps, note, links } = r;
  return (
    v_flex()
      .id(`work-${w.path}`)
      .mx(6)
      .px(8)
      .py(4)
      .gap(1)
      .rounded(7)
      .border_l_2()
      .border_color(r.selected ? t.accent : "#00000000")
      .cursor_pointer()
      .when(Boolean(space?.active), (/** @type {any} */ el) =>
        el.bg(t.selected ?? t.hover),
      )
      .hover((/** @type {any} */ s) => s.bg(t.hover))
      // Only entering a row renders: leaving one is followed by entering
      // the next, and leaving the list is handled on "work-list".
      .on_hover((/** @type {any} */ hovered, /** @type {any} */ cx) =>
        ui.hoverRow(cx, w, hovered),
      )
      .on_click(() => ui.open(w))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(statusEl(ui, r))
          .child(
            div()
              .flex_shrink(1)
              .min_w(64)
              .flex()
              .child(
                div()
                  .flex_shrink(1)
                  .min_w(0)
                  .truncate()
                  .text_size(12.5)
                  .text_color(t.foreground)
                  .when(Boolean(space?.active), (/** @type {any} */ d) =>
                    d.font_semibold(),
                  )
                  .child(r.title),
              ),
          )
          // The rest of the line after the title (sized to its text): the
          // PR, at the right; it also pushes ↗ there.
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .justify_end()
              // Narrow, the PR is a word, then a glyph (see prLabel),
              // never cut.
              .when(
                Boolean(pr) && pr.shown !== "full",
                (/** @type {any} */ el) =>
                  el.child(
                    div()
                      .id(`work-pr-${w.path}`)
                      .flex_none()
                      .text_size(11)
                      .text_color(toneOf(t, pr.tone))
                      .tooltip(pr.text)
                      .child(pr.head),
                  ),
              )
              .when(
                Boolean(pr) && pr.shown === "full",
                (/** @type {any} */ el) =>
                  el.child(
                    // The tail (the tone: checks, conflicts) stays whole;
                    // the rest of the PR truncates before it.
                    h_flex()
                      .min_w(0)
                      .gap(4)
                      .text_size(11)
                      .text_color(toneOf(t, pr.tone))
                      .child(div().min_w(0).truncate().child(pr.head))
                      .when(Boolean(pr.tail), (/** @type {any} */ e) =>
                        e.child(div().flex_none().child(pr.tail)),
                      ),
                  ),
              ),
          )
          .when(links.length > 0, (/** @type {any} */ el) =>
            el.child(
              r.selected || ui.hovered === w.path || ui.linksOpen === w.path
                ? linksMenu(ui, w, links)
                : div().w(LINKS_W).flex_none(),
            ),
          ),
      )
      // Always there on a ticket's row, even while empty: its summary,
      // status and cost come from lookups that finish later, and the line
      // appearing then would push every row below it down. Any other
      // branch (its title already) is one line unless agents there cost.
      .when(
        Boolean(r.sub) || Boolean(w.handle) || Boolean(r.costText),
        (/** @type {any} */ el) =>
          el.child(
            h_flex()
              .pl(18)
              .gap(6)
              .child(
                div()
                  .flex_1()
                  .min_w(48)
                  .truncate()
                  .text_size(11)
                  .text_color(t.dim)
                  .child(r.sub),
              )
              .when(Boolean(r.ticketStatus), (/** @type {any} */ e) =>
                e.child(
                  // Capped, so the summary keeps most of the line.
                  div()
                    .flex_shrink(1)
                    .min_w(0)
                    .max_w(88)
                    .truncate()
                    .text_size(11)
                    .text_color(t.dim)
                    .child(r.ticketStatus),
                ),
              )
              .when(Boolean(r.costText), (/** @type {any} */ e) =>
                e.child(costEl(ui, r)),
              ),
          ),
      )
      .when(steps.length > 0 || Boolean(note), (/** @type {any} */ el) =>
        el.child(
          h_flex()
            .flex_wrap()
            .pl(18)
            .pt(2)
            .gap_x(4)
            .gap_y(3)
            .items_center()
            .children(steps.map((/** @type {any} */ s) => stepButton(ui, r, s)))
            .when(Boolean(note), (/** @type {any} */ e) =>
              e.child(
                div()
                  .flex_1()
                  .min_w(60)
                  .truncate()
                  .text_size(11)
                  .text_color(toneOf(t, note.tone))
                  .child(note.text),
              ),
            ),
        ),
      )
  );
}

// A stacked PR `p` under its row (work-rows.js, stackItem): one indented
// line, no steps; a click opens the PR. Merged or closed: dimmed. A tree
// connector (├ / └ for the last) ties it to the row above.
export function subRowEl(
  /** @type {any} */ ui,
  /** @type {any} */ p,
  /** @type {any} */ last,
) {
  const { t } = ui;
  return h_flex()
    .id(`work-${p.key}`)
    .mx(6)
    .pl(18)
    .pr(8)
    .h(20)
    .gap(6)
    .items_center()
    .rounded(6)
    .border_l_2()
    .border_color(p.selected ? t.accent : "#00000000")
    .cursor_pointer()
    .hover((/** @type {any} */ s) => s.bg(t.hover))
    .tooltip(p.tip)
    .on_click(() => ui.openStacked(p))
    .child(
      div()
        .flex_none()
        .text_size(11)
        .text_color(t.dim)
        .child(last ? "└" : "├"),
    )
    .child(
      div()
        .flex_none()
        .text_size(11)
        .text_color(toneOf(t, p.tone))
        .child(p.shown),
    )
    .child(
      div()
        .flex_1()
        .min_w(0)
        .truncate()
        .text_size(11)
        .text_color(p.dim ? t.dim : t.muted)
        .child(p.title),
    );
}

// On the rail: the PR's glyph, small, under its row's dot.
function subDotEl(/** @type {any} */ ui, /** @type {any} */ p) {
  const { t } = ui;
  return div()
    .id(`work-${p.key}`)
    .mx(4)
    .h(16)
    .flex()
    .justify_center()
    .items_center()
    .rounded(6)
    .border_l_2()
    .border_color(p.selected ? t.accent : "#00000000")
    .cursor_pointer()
    .hover((/** @type {any} */ s) => s.bg(t.hover))
    .tooltip(p.tip)
    .on_click(() => ui.openStacked(p))
    .text_size(9)
    .text_color(toneOf(t, p.tone))
    .child(p.glyph);
}

// What a row costs (its agents, at API prices): a tooltip says what.
function costEl(/** @type {any} */ ui, /** @type {any} */ r) {
  return div()
    .id(`work-cost-${r.w.path}`)
    .flex_none()
    .text_size(11)
    .text_color(ui.t.dim)
    .tooltip("What agents working here have cost (at API prices)")
    .child(r.costText);
}

// The "+k more" row below a capped repo group (workRepoRows), or "Show fewer"
// once expanded past the cap. On the rail, "+k", and "−".
function moreRowEl(/** @type {any} */ ui, /** @type {any} */ g) {
  const { t, rail } = ui;
  const label = g.more
    ? rail
      ? `+${g.more}`
      : `+${g.more} more`
    : rail
      ? "−"
      : "Show fewer";
  return div()
    .id(`work-more-${g.key}`)
    .mx(rail ? 4 : 6)
    .px(rail ? 6 : 24)
    .h(20)
    .flex()
    .items_center()
    .when(rail, (/** @type {any} */ el) => el.justify_center())
    .rounded(6)
    .cursor_pointer()
    .hover((/** @type {any} */ s) => s.bg(t.hover))
    .text_size(11)
    .text_color(t.dim)
    .tooltip(
      g.more
        ? `Show ${g.more} less recently changed worktree${g.more === 1 ? "" : "s"}`
        : "Show only the most recently changed",
    )
    .on_click((/** @type {any} */ _e, /** @type {any} */ cx) =>
      ui.expand(cx, g.key),
    )
    .child(label);
}

// The rows of a group, each with its stacked PRs under it.
function rowsOf(/** @type {any} */ ui, /** @type {any} */ g) {
  return g.worktrees.flatMap((/** @type {any} */ r) => [
    rowEl(ui, r),
    ...r.stack.map(
      (/** @type {any} */ p, /** @type {any} */ i, /** @type {any} */ all) =>
        subRowEl(ui, p, i === all.length - 1),
    ),
  ]);
}

// A repo group: its header (its hub's row, in full) and its rows; a "+k more"
// row under them when the cap hides some (or "Show fewer" once expanded).
export function groupEl(/** @type {any} */ ui, /** @type {any} */ g) {
  const el = groupBodyEl(ui, g);
  return g.more || g.fewer ? el.child(moreRowEl(ui, g)) : el;
}

// A group without its "more" row. In full, the header is also the repo's hub's
// row (the hub has no ticket, PR or steps, so a row of its own would repeat in
// every group): the chevron folds the group, the rest opens the hub like a
// row. By stage, a plain header (no hub): the chevron and name fold it.
function groupBodyEl(/** @type {any} */ ui, /** @type {any} */ g) {
  const { t, rail } = ui;
  const { hub } = g;
  const fold = (/** @type {any} */ cx) => ui.fold(cx, g);
  const chevron = svg(
    `mods/workspace-chrome/chevron-${g.open ? "down" : "right"}.svg`,
  )
    .size(11)
    .flex_none()
    .text_color(t.dim);
  if (rail)
    return v_flex()
      .child(
        h_flex()
          .id(`work-repo-${g.key}`)
          .mx(4)
          .px(6)
          .h(24)
          .gap(5)
          .items_center()
          .justify_center()
          .tooltip(`${g.name} (${g.count})`)
          .rounded(6)
          .cursor_pointer()
          .hover((/** @type {any} */ s) => s.bg(t.hover))
          .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => fold(cx))
          .child(chevron)
          // A monogram tells repos apart without a hover.
          .child(
            div()
              .text_size(11)
              .font_semibold()
              .text_color(t.muted)
              .child(g.monogram),
          ),
      )
      .when(Boolean(hub), (/** @type {any} */ el) => el.child(dotEl(ui, hub)))
      .children(
        g.worktrees.flatMap((/** @type {any} */ r) => [
          dotEl(ui, r),
          ...r.stack.map((/** @type {any} */ p) => subDotEl(ui, p)),
        ]),
      );
  if (!hub)
    return v_flex()
      .child(
        h_flex()
          .id(`work-group-${g.key}`)
          .mx(6)
          .px(6)
          .h(24)
          .gap(5)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .hover((/** @type {any} */ s) => s.bg(t.hover))
          .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => fold(cx))
          .child(chevron)
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(12.5)
              .font_semibold()
              .text_color(t.muted)
              .child(g.name),
          )
          .child(
            div()
              .id(`work-count-${g.key}`)
              .flex_none()
              .text_size(11)
              .text_color(t.muted)
              .tooltip(g.count)
              .child(g.size),
          ),
      )
      .children(rowsOf(ui, g));
  return v_flex()
    .child(
      h_flex()
        .id(`work-repo-${g.repo.path}`)
        .mx(6)
        .px(6)
        .h(24)
        .gap(5)
        .items_center()
        .rounded(6)
        .border_l_2()
        .border_color(hub.selected ? t.accent : "#00000000")
        .cursor_pointer()
        .when(Boolean(hub.space?.active), (/** @type {any} */ el) =>
          el.bg(t.selected ?? t.hover),
        )
        .hover((/** @type {any} */ s) => s.bg(t.hover))
        .tooltip(`${g.name} hub: ${hub.title}`)
        .on_click(() => ui.open(hub.w))
        .child(
          div()
            .id(`work-fold-${g.repo.path}`)
            .flex_none()
            .rounded(4)
            .hover((/** @type {any} */ s) => s.bg(t.hover))
            .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => {
              cx.stop_propagation();
              fold(cx);
            })
            .child(chevron),
        )
        .child(statusEl(ui, hub))
        .child(
          div()
            .flex_shrink(1)
            .min_w(0)
            .truncate()
            .text_size(12.5)
            .font_semibold()
            .text_color(t.muted)
            .child(g.name),
        )
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(11)
            .text_color(t.dim)
            .child(hub.title),
        )
        .when(Boolean(hub.costText), (/** @type {any} */ el) =>
          el.child(costEl(ui, hub)),
        )
        .child(
          div()
            .id(`work-count-${g.repo.path}`)
            .flex_none()
            .text_size(11)
            // Neutral, like the repo name: the count carries no state.
            .text_color(t.muted)
            .tooltip(g.count)
            .child(g.size),
        ),
    )
    .children(rowsOf(ui, g));
}

// A message in the list: in full on the rail too, on hover (a rail shows "!"
// for a problem, "…" for loading).
export function messageEl(
  /** @type {any} */ ui,
  /** @type {any} */ id,
  /** @type {any} */ text,
  /** @type {any} */ color,
) {
  const { rail } = ui;
  return rail
    ? div()
        .id(`work-${id}`)
        .py(4)
        .flex()
        .justify_center()
        .text_size(12.5)
        .text_color(color)
        .tooltip(text)
        .child(id === "problem" ? "!" : "…")
    : div().px(14).py(4).text_size(11).text_color(color).child(text);
}

// The list's body: the groups, or the message while they load or when there
// are none. `loading`: the groups aren't known yet.
export function bodyEl(
  /** @type {any} */ ui,
  /** @type {any} */ view,
  /** @type {any} */ loading,
) {
  if (loading) return messageEl(ui, "loading", "Loading worktrees…", ui.t.dim);
  return view.groups.length
    ? v_flex()
        .gap(4)
        .children(view.groups.map((/** @type {any} */ g) => groupEl(ui, g)))
    : messageEl(
        ui,
        "empty",
        "No worktrees yet. Press + to start a ticket.",
        ui.t.dim,
      );
}
