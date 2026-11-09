// Usage: what your agents cost, for the sidebar (see usage.js for where it
// comes from). Today, the last 7 and 30 days, then the last 30 days by agent
// and model, most expensive first. Days are UTC. ↻ refreshes now; it also
// refreshes every 2 minutes. Narrower than RAIL, it shows today's cost only.
// The Work sidebar shows each row's cost from the same data. Above them, a
// Claude subscription's plan limits (limits.js): how much of the 5-hour
// session and the week is used, which is what a Pro or Max plan is billed by.
// They refresh every 5 minutes (and with ↻).

import { h_flex, v_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { theme } from "herdr";
import { C, configReady } from "./config.js";
import { planLimits } from "./limits.js";
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
const RAIL = 160;
const TOP = 5;

const dayAgo = (n) =>
  new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

const AGENTS = { "claude-code": "Claude Code", codex: "Codex" };

// Groups summed by `keyOf`, most expensive first.
function by(groups, keyOf) {
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
  init(_props, cx) {
    this.state = LOADING;
    this.width = null;
    // [{ home, windows }] once read; error: why the last read failed.
    this.limits = { list: null, error: null };
    this.read(cx);
    this.readLimits(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.load(cx));
    cx.timer.every(LIMITS_MS, (cx) => this.readLimits(cx));
  }

  // maxAge: reuse a scan this recent (usageGroups), 0 to scan now.
  load(cx, maxAge) {
    if (this.state.phase === "loading") return;
    this.state = { ...this.state, phase: "loading" };
    this.read(cx, maxAge);
  }

  readLimits(cx) {
    if (this.limitsLoading) return;
    this.limitsLoading = true;
    cx.spawn(async (cx) => {
      try {
        await configReady();
        this.limits = { list: await planLimits(), error: null };
      } catch (e) {
        this.limits = { ...this.limits, error: `${e.message ?? e}` };
      }
      this.limitsLoading = false;
      cx.notify();
    });
  }

  read(cx, maxAge) {
    cx.spawn(async (cx) => {
      this.state = await settled(this.state, async () => {
        await configReady();
        return usageGroups(maxAge);
      });
      cx.notify();
    });
  }

  render(_cx) {
    const t = theme();
    const rail = this.width !== null && this.width < RAIL;
    const { phase, error } = this.state;
    const groups = this.state.groups ?? [];
    const since = (d) => groups.filter((g) => g.day >= d);
    const recent = since(dayAgo(29));
    const today = total(since(dayAgo(0)));
    const amount = (s) =>
      s.unpriced && !s.cost ? "no price" : dollars(s.cost);

    const line = (id, label, s, strong = false, tip = null) =>
      h_flex()
        .id(id)
        .when(Boolean(tip), (el) => el.tooltip(tip))
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
            .text_color(strong ? t.foreground : t.muted)
            .child(label),
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
            .text_color(t.foreground)
            .when(strong, (d) => d.font_semibold())
            .child(amount(s)),
        );

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
          .child("USAGE"),
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
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Refresh now")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.load(cx, 0);
            this.readLimits(cx);
          })
          .child("↻"),
      );

    const message = (text, color) =>
      div().px(14).py(4).text_size(11).text_color(color).child(text);

    const heading = (text) =>
      div()
        .px(14)
        .pt(6)
        .pb(2)
        .text_size(11)
        .font_semibold()
        .text_color(t.dim)
        .child(text);

    const limitList = this.limits.list ?? [];
    // The rail's limit: the fuller of the session and the week, labelled.
    const railLimit = (limitList[0]?.windows ?? [])
      .filter((w) => w.key === "session" || /week/i.test(w.label))
      .map((w) => ({ ...w, tag: w.key === "session" ? "S" : "W" }))
      .reduce((a, w) => (a && a.used >= w.used ? a : w), null);
    const percent = (n) => `${Math.round(n)}%`;
    // Green while there's room, then warning, then red near the limit.
    const fullness = (n) =>
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
            limitList.flatMap((l) => [
              heading(
                limitList.length > 1
                  ? `CLAUDE CODE LIMITS (${l.home})`
                  : "CLAUDE CODE LIMITS",
              ),
              ...l.windows.flatMap((w) => [
                h_flex()
                  .id(`usage-limit-${l.home}-${w.key}`)
                  .when(Boolean(w.resets), (el) =>
                    el.tooltip(`Resets ${w.resets}`),
                  )
                  .px(14)
                  .h(20)
                  .gap(8)
                  .items_center()
                  .text_size(12.5)
                  .child(
                    div()
                      .min_w(0)
                      .truncate()
                      .text_color(t.muted)
                      .child(w.label),
                  )
                  // The date gives way first: it shrinks so heavily that the
                  // label only truncates once the date is gone, and the
                  // row's tooltip still says when the window resets.
                  .child(div().flex_1())
                  .child(
                    div()
                      .flex_shrink(1000)
                      .min_w(0)
                      .truncate()
                      .text_size(11)
                      .text_color(t.dim)
                      .child(w.resets ?? ""),
                  )
                  .child(
                    div()
                      .w(52)
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
          .when(Boolean(this.limits.error), (el) =>
            el.child(message(this.limits.error, t.blocked)),
          );

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
              .when(Boolean(limits), (el) =>
                el
                  .child(
                    div()
                      .mx(14)
                      .mt(6)
                      .border_t_1()
                      .border_color(t.border ?? t.dim),
                  )
                  .child(heading("AGENT COSTS (API PRICES)")),
              )
              .child(line("usage-today", "Today", today, true))
              .child(line("usage-7", "7 days", total(since(dayAgo(6)))))
              .child(line("usage-30", "30 days", total(recent)))
              .child(heading("30 DAYS BY MODEL"))
              .children(
                by(recent, (g) => JSON.stringify([g.agent, g.model, g.fast]))
                  .slice(0, TOP)
                  .map((r) => {
                    const [agent, model, fast] = JSON.parse(r.name);
                    const name = `${model}${fast ? " (fast)" : ""}`;
                    return line(
                      `usage-model-${r.name}`,
                      name,
                      r,
                      false,
                      `${AGENTS[agent] ?? agent}: ${name}`,
                    );
                  }),
              )
              .when(Boolean(problem), (el) => el.child(problem));

    return v_flex()
      .id("usage")
      .size_full()
      .min_h(0)
      .on_size_change((size, cx) => {
        // The rail switch and the plan limits' bars depend on the width.
        const changed = size.width !== this.width;
        this.width = size.width;
        if (changed) cx.notify();
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
              .child(
                railLimit
                  ? `${railLimit.tag} ${percent(railLimit.used)}`
                  : this.state.groups === null
                    ? error
                      ? "!"
                      : "…"
                    : amount(today),
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
                  .when(Boolean(limits), (el) => el.child(limits))
                  .child(body),
              ),
      );
  }
}
