// Usage: what your agents cost, for the sidebar (see usage.js for where it
// comes from). Today, the last 7 and 30 days, then the last 30 days by agent
// and model, most expensive first. Days are UTC. ↻ refreshes now; it also
// refreshes every 2 minutes. Narrower than RAIL, it shows today's cost only.
// The Work sidebar shows each row's cost from the same data.

import { h_flex, v_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { theme } from "herdr";
import { C, configReady } from "./config.js";
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
    this.read(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.load(cx));
  }

  // maxAge: reuse a scan this recent (usageGroups), 0 to scan now.
  load(cx, maxAge) {
    if (this.state.phase === "loading") return;
    this.state = { ...this.state, phase: "loading" };
    this.read(cx, maxAge);
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
        .text_size(11.5)
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
          .text_size(12)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Refresh now")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.load(cx, 0);
          })
          .child("↻"),
      );

    const message = (text, color) =>
      div().px(14).py(4).text_size(11.5).text_color(color).child(text);

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
              .child(line("usage-today", "Today", today, true))
              .child(line("usage-7", "7 days", total(since(dayAgo(6)))))
              .child(line("usage-30", "30 days", total(recent)))
              .child(
                div()
                  .px(14)
                  .pt(6)
                  .pb(2)
                  .text_size(10.5)
                  .font_semibold()
                  .text_color(t.dim)
                  .child("30 DAYS BY MODEL"),
              )
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
        const was = this.width !== null && this.width < RAIL;
        this.width = size.width;
        if (size.width < RAIL !== was) cx.notify();
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
              .tooltip(error ?? `Agents today: ${amount(today)}`)
              .child(
                this.state.groups === null
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
                v_flex().flex_1().min_h(0).overflow_y_scrollbar().child(body),
              ),
      );
  }
}
