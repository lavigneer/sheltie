// Usage: what your agents cost, for the sidebar (see usage.js for where it
// comes from). Today, the last 7 and 30 days, then the last 30 days by agent
// and model, most expensive first (the 30 days' tooltip). Days are UTC. ↻ refreshes now; it also
// refreshes every 2 minutes. Narrower than RAIL, it shows today's cost only.
// The Work sidebar shows each row's cost from the same data. Above them, a
// Claude subscription's plan limits (limits.js): how much of the 5-hour
// session and the week is used, which is what a Pro or Max plan is billed by.
// They refresh every 5 minutes (and with ↻).

import { h_flex, v_flex } from "gpui-base";
import { div, svg, View } from "gpui-kit";
import { theme } from "herdr";
import { C, configReady } from "./config.js";
import { planLimits, resetsLabel } from "./limits.js";
import { band, RAIL, resize } from "./sidebar.js";
import {
  dollars,
  LOADING,
  settled,
  tokenCount,
  total,
  usageGroups,
} from "./usage.js";

const DAY_MS = 86_400_000;
const REFRESH_MS = 120_000;
const LIMITS_MS = 300_000;
// Narrower than this, the limits leave out when they reset (the row's
// tooltip still says) and the cost heading is shortened.
const NARROW = 240;
const TOP = 5;
const RAIL_BAR = 28;

const dayAgo = (/** @type {any} */ n) =>
  new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

/** @type {Record<string, string>} */
const AGENTS = { "claude-code": "Claude Code", codex: "Codex" };

// Groups summed by `keyOf`, most expensive first.
function by(/** @type {any} */ groups, /** @type {any} */ keyOf) {
  const m = new Map();
  for (const g of groups) {
    const k = keyOf(g);
    m.set(k, [...(m.get(k) ?? []), g]);
  }
  return [...m]
    .map(([name, gs]) => ({ name, ...total(gs) }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
}

export default class Usage extends View {
  /** @type {number | null} */
  width = null;
  init(/** @type {any} */ _props, /** @type {any} */ cx) {
    this.state = LOADING;
    /** @type {number | null} */
    this.width = null;
    // The plan limits, in settled()'s shape: list is [{ home, windows }].
    this.limits = { phase: "idle", list: null, error: null };
    this.read(cx);
    this.readLimits(cx);
    cx.timer.every(REFRESH_MS, (/** @type {any} */ cx) => this.load(cx));
    cx.timer.every(LIMITS_MS, (/** @type {any} */ cx) => this.readLimits(cx));
  }

  // maxAge: reuse a scan this recent (usageGroups), 0 to scan now.
  load(/** @type {any} */ cx, /** @type {any} */ maxAge = undefined) {
    if (this.state.phase === "loading") return;
    this.state = { ...this.state, phase: "loading" };
    this.read(cx, maxAge);
  }

  readLimits(/** @type {any} */ cx) {
    if (this.limits.phase === "loading") return;
    this.limits = { ...this.limits, phase: "loading" };
    cx.spawn(async (/** @type {any} */ cx) => {
      this.limits = await settled(
        this.limits,
        async () => {
          await configReady();
          return planLimits();
        },
        "list",
      );
      cx.notify();
    });
  }

  read(/** @type {any} */ cx, /** @type {any} */ maxAge = undefined) {
    cx.spawn(async (/** @type {any} */ cx) => {
      this.state = await settled(this.state, async () => {
        await configReady();
        return usageGroups(maxAge);
      });
      cx.notify();
    });
  }

  render(/** @type {any} */ _cx) {
    const t = theme();
    const span = band(this.width, [
      ["rail", RAIL],
      ["narrow", NARROW],
    ]);
    const rail = span === "rail";
    const narrow = span !== "full";
    const { phase, error } = this.state;
    const groups = this.state.groups ?? [];
    const since = (/** @type {any} */ d) =>
      groups.filter((/** @type {any} */ g) => g.day >= d);
    const recent = since(dayAgo(29));
    const today = total(since(dayAgo(0)));
    const amount = (/** @type {any} */ s) =>
      s.unpriced && !s.cost ? "no price" : dollars(s.cost);

    // Today leads: its cost in the foreground, so it reads first, but at the
    // same size as the 7 and 30 day totals below it.
    const lead = (/** @type {any} */ s) =>
      h_flex()
        .id("usage-today")
        .px(14)
        .pt(4)
        .gap(8)
        .items_end()
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(12.5)
            .text_color(t.muted)
            .child("Today"),
        )
        .child(
          div()
            .flex_none()
            .text_size(11)
            .text_color(t.dim)
            .child(tokenCount(s.tokens)),
        )
        .child(
          div()
            .w(52)
            .flex_none()
            .flex()
            .justify_end()
            .text_size(11.5)
            .font_semibold()
            .text_color(t.foreground)
            .child(amount(s)),
        );

    // 7 and 30 days sit under Today as quieter context.
    const line = (
      /** @type {any} */ id,
      /** @type {any} */ label,
      /** @type {any} */ s,
      /** @type {string | null} */ tip = null,
    ) =>
      h_flex()
        .id(id)
        .when(Boolean(tip), (/** @type {any} */ el) => el.tooltip(tip))
        .px(14)
        .h(18)
        .gap(8)
        .items_center()
        .text_size(11.5)
        .child(
          div().flex_1().min_w(0).truncate().text_color(t.dim).child(label),
        )
        .child(
          div()
            .flex_none()
            .text_size(10.5)
            .text_color(t.dim)
            .child(tokenCount(s.tokens)),
        )
        .child(
          div()
            .w(52)
            .flex_none()
            .flex()
            .justify_end()
            .text_color(t.muted)
            .child(amount(s)),
        );

    const refreshing =
      this.state.phase === "loading" || this.limits.phase === "loading";
    const header = h_flex()
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
          .child("Usage"),
      )
      .child(
        div()
          .id("usage-refresh")
          .h(20)
          .px(5)
          .flex()
          .items_center()
          .rounded(5)
          .text_size(12.5)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((/** @type {any} */ s) =>
            s.bg(t.hover).text_color(t.foreground),
          )
          .tooltip(refreshing ? "Refreshing…" : "Refresh now")
          .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => {
            cx.stop_propagation();
            this.load(cx, 0);
            this.readLimits(cx);
            cx.notify();
          })
          .child(
            refreshing
              ? svg("mods/workspace-chrome/spinner.svg").size(11).spin(900)
              : "↻",
          ),
      );

    const message = (/** @type {any} */ text, /** @type {any} */ color) =>
      div().px(14).py(4).text_size(11).text_color(color).child(text);

    const heading = (/** @type {any} */ text) =>
      div()
        .px(14)
        .pt(6)
        .pb(2)
        .text_size(11)
        .font_semibold()
        .text_color(t.dim)
        .truncate()
        .child(text);

    const limitList = this.limits.list ?? [];
    // The rail's limit: the fuller of the session and the week, labelled.
    const railLimit = (limitList[0]?.windows ?? [])
      .filter(
        (/** @type {any} */ w) => w.key === "session" || /week/i.test(w.label),
      )
      .map((/** @type {any} */ w) => ({
        ...w,
        tag: w.key === "session" ? "S" : "W",
      }))
      .reduce(
        (/** @type {any} */ a, /** @type {any} */ w) =>
          a && a.used >= w.used ? a : w,
        null,
      );
    const percent = (/** @type {any} */ n) => `${Math.round(n)}%`;
    // Green while there's room, then warning, then red near the limit.
    const fullness = (/** @type {any} */ n) =>
      n >= 90
        ? t.blocked
        : n >= 70
          ? (t.working ?? t.accent)
          : (t.done ?? t.accent);
    // The bar's track spans the sidebar less its 14 px sides.
    const barWidth = Math.max(0, (this.width ?? 0) - 28);
    const limits = !limitList.length
      ? this.limits.error
        ? message(this.limits.error, t.blocked)
        : null
      : v_flex()
          .children(
            limitList.flatMap((/** @type {any} */ l) => [
              heading(
                limitList.length > 1
                  ? `Claude Code limits (${l.home})`
                  : "Claude Code limits",
              ),
              ...l.windows.flatMap((/** @type {any} */ w) => [
                h_flex()
                  .id(`usage-limit-${l.home}-${w.key}`)
                  .when(Boolean(w.resets), (/** @type {any} */ el) =>
                    el.tooltip(`${w.label} limit ${resetsLabel(w.resets)}`),
                  )
                  .px(14)
                  .h(20)
                  .gap(8)
                  .items_center()
                  .text_size(12.5)
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .text_color(t.muted)
                      .child(w.label),
                  )
                  // When it resets, left out when narrow: the label and the
                  // percentage are what tell the bars apart.
                  .when(!narrow && Boolean(w.resets), (/** @type {any} */ el) =>
                    el.child(
                      div()
                        .flex_none()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(resetsLabel(w.resets)),
                    ),
                  )
                  .child(
                    div()
                      .flex_none()
                      .flex()
                      .justify_end()
                      .text_color(fullness(w.used))
                      .child(percent(w.used)),
                  ),
                // How full: a track with the used part filled, coloured
                // like the percentage.
                div()
                  .mx(14)
                  .mb(4)
                  .h(4)
                  .rounded(2)
                  .bg(t.hover)
                  .child(
                    div()
                      .h_full()
                      .rounded(2)
                      .bg(fullness(w.used))
                      .w(
                        Math.round(
                          (barWidth * Math.min(100, Math.max(0, w.used))) / 100,
                        ),
                      ),
                  ),
              ]),
            ]),
          )
          .when(Boolean(this.limits.error), (/** @type {any} */ el) =>
            el.child(message(this.limits.error, t.blocked)),
          );

    const topModels = by(recent, (/** @type {any} */ g) =>
      JSON.stringify([g.agent, g.model, g.fast]),
    )
      .slice(0, TOP)
      .map((r) => {
        const [agent, model, fast] = JSON.parse(r.name);
        return `${AGENTS[agent] ?? agent}: ${model}${fast ? " (fast)" : ""} ${dollars(r.cost)}`;
      });
    const problem = phase === "failed" ? message(error, t.blocked) : null;
    const body =
      this.state.groups === null
        ? (problem ?? message("Reading session logs…", t.dim))
        : !groups.length
          ? (problem ??
            message(
              `No sessions yet in ${C.usage.agents.map((a) => a.home).join(", ")}`,
              t.dim,
            ))
          : v_flex()
              .pb(6)
              // Under the plan limits, set apart: these are what the tokens
              // would cost at API prices, not what a plan is billed.
              .when(Boolean(limits), (/** @type {any} */ el) =>
                el
                  .child(
                    div()
                      .mx(14)
                      .mt(6)
                      .border_t_1()
                      .border_color(t.border ?? t.dim),
                  )
                  .child(
                    heading(
                      narrow ? "Agent costs" : "Agent costs (API prices)",
                    ),
                  ),
              )
              .child(lead(today))
              .child(line("usage-7", "7 days", total(since(dayAgo(6)))))
              // The breakdown by agent and model is the 30 days' tooltip,
              // so the block fits the sidebar.
              .child(
                line(
                  "usage-30",
                  "30 days",
                  total(recent),
                  topModels.length
                    ? `By model:\n${topModels.join("\n")}`
                    : null,
                ),
              )
              .when(Boolean(problem), (/** @type {any} */ el) =>
                el.child(problem),
              );

    return v_flex()
      .id("usage")
      .size_full()
      .min_h(0)
      .on_size_change((/** @type {any} */ size, /** @type {any} */ cx) => {
        // The plan limits' bars span the sidebar, so any width change shows
        // (not just a change of band).
        if (resize(this, size.width, (w) => w)) cx.notify();
      })
      .child(
        rail
          ? div()
              .id("usage-rail")
              .py(6)
              .flex()
              .justify_center()
              .text_size(9.5)
              .text_color(t.dim)
              .tooltip(
                error ??
                  `Agents today: ${amount(today)}${railLimit ? `; Claude Code ${railLimit.label}: ${percent(railLimit.used)} used` : ""}`,
              )
              .flex_col()
              .items_center()
              .gap(2)
              .child(
                railLimit
                  ? `${railLimit.tag} ${percent(railLimit.used)}`
                  : this.state.groups === null
                    ? error
                      ? "!"
                      : "…"
                    : amount(today),
              )
              // A small bar under the rail's percentage, so it reads as a
              // limit's fullness rather than a stray number.
              .when(Boolean(railLimit), (/** @type {any} */ el) =>
                el.child(
                  div()
                    .w(RAIL_BAR)
                    .h(3)
                    .rounded(2)
                    .bg(t.hover)
                    .child(
                      div()
                        .h_full()
                        .rounded(2)
                        .bg(fullness(railLimit.used))
                        .w(
                          Math.round(
                            (RAIL_BAR *
                              Math.min(100, Math.max(0, railLimit.used))) /
                              100,
                          ),
                        ),
                    ),
                ),
              )
          : v_flex()
              .size_full()
              .min_h(0)
              .child(header)
              .child(
                v_flex()
                  .flex_1()
                  .min_h(0)
                  .overflow_y_scrollbar()
                  .when(Boolean(limits), (/** @type {any} */ el) =>
                    el.child(limits),
                  )
                  .child(body),
              ),
      );
  }
}
