// Usage: what your agents cost, from Claude Code's transcripts (see usage.js).
//
// Totals for today, the last 7 and 30 days and all time, then the last 30
// days by model and by folder (most expensive first). Days are UTC. Opened
// with mod.open:usage (Ctrl+Shift+U); Esc closes. The Work sidebar shows each
// row's cost from the same data.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, theme, props, closeOverlay } from "herdr";
import { C, configReady } from "./config.js";
import { moveKey } from "./lib.js";
import { dollars, folderOf, tokenCount, total, usageGroups } from "./usage.js";

const DAY_MS = 86_400_000;
const TOP = 15;

const dayAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

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
    this.groups = null; // null while loading
    this.problem = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      await configReady();
      try {
        this.groups = await usageGroups();
      } catch (e) {
        this.groups = [];
        this.problem = e?.message ?? String(e);
      }
      cx.notify();
    });
  }

  // Not named close(): Herdr calls a View's close() itself when the overlay goes.
  dismiss() {
    closeOverlay(props().overlay);
  }

  render() {
    const t = theme();
    const groups = this.groups ?? [];
    const since = (d) => groups.filter((g) => g.day >= d);
    const recent = since(dayAgo(29));
    // A folder's name: Claude Code's, without your home folder's part.
    const homePart = folderOf(home());
    const folderName = (f) =>
      f.startsWith(homePart) ? `~${f.slice(homePart.length)}` : f;
    const amount = (s) =>
      s.cost || !s.unpriced ? dollars(s.cost) : "?";

    const tile = (label, s) =>
      v_flex()
        .flex_1()
        .min_w(0)
        .px(10)
        .py(8)
        .gap(2)
        .rounded(8)
        .border_1()
        .border_color(t.border ?? t.dim)
        .child(div().text_size(11).text_color(t.dim).child(label))
        .child(
          div()
            .text_size(16)
            .font_semibold()
            .text_color(t.foreground)
            .child(amount(s)),
        )
        .child(
          div()
            .text_size(11)
            .text_color(t.dim)
            .child(`${tokenCount(s.tokens)} tokens`),
        );

    const line = (id, r) =>
      h_flex()
        .id(id)
        .px(10)
        .h(24)
        .gap(10)
        .items_center()
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_color(t.foreground)
            .child(r.name),
        )
        .child(
          div()
            .flex_none()
            .text_size(11)
            .text_color(t.dim)
            .child(tokenCount(r.tokens)),
        )
        .child(
          div()
            .w(64)
            .flex_none()
            .flex()
            .justify_end()
            .text_color(t.foreground)
            .child(r.unpriced && !r.cost ? "no price" : dollars(r.cost)),
        );

    const section = (title, rows, prefix) =>
      v_flex()
        .gap(2)
        .child(
          div()
            .px(10)
            .text_size(11)
            .font_semibold()
            .text_color(t.dim)
            .child(title),
        )
        .children(rows.map((r) => line(`usage-${prefix}-${r.name}`, r)));

    const folders = by(recent, (g) => folderName(g.folder));
    const body =
      this.groups === null
        ? div().px(10).py(8).text_color(t.dim).child("Reading transcripts…")
        : !groups.length
          ? div()
              .px(10)
              .py(8)
              .text_color(this.problem ? t.blocked : t.dim)
              .child(
                this.problem ??
                  `No Claude Code transcripts in ${C.usage.claudeHomes.join(", ")}`,
              )
          : v_flex()
              .flex_1()
              .min_h(0)
              .gap(12)
              .overflow_y_scrollbar()
              .child(
                h_flex()
                  .gap(8)
                  .child(tile("Today", total(since(dayAgo(0)))))
                  .child(tile("7 days", total(since(dayAgo(6)))))
                  .child(tile("30 days", total(recent)))
                  .child(tile("All time", total(groups))),
              )
              .child(
                section(
                  "BY MODEL · 30 DAYS",
                  by(recent, (g) => (g.fast ? `${g.model} (fast)` : g.model)),
                  "model",
                ),
              )
              .child(
                section(
                  folders.length > TOP
                    ? `BY FOLDER · 30 DAYS · TOP ${TOP}`
                    : "BY FOLDER · 30 DAYS",
                  folders.slice(0, TOP),
                  "folder",
                ),
              )
              .child(
                div()
                  .px(10)
                  .text_size(11)
                  .text_color(t.dim)
                  .child(
                    "At API prices (cache and fast mode included); on a subscription, what the same use would cost. Days are UTC.",
                  ),
              );

    return v_flex()
      .id("usage")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        if (!moveKey(e, this, 0, () => this.dismiss())) return;
        cx.stop_propagation();
      })
      .child(
        h_flex()
          .items_center()
          .child(
            div()
              .flex_1()
              .text_size(15)
              .font_semibold()
              .text_color(t.foreground)
              .child("Agent usage"),
          )
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .when(Boolean(this.problem && groups.length), (el) =>
        el.child(div().px(10).text_size(11).text_color(t.blocked).child(this.problem)),
      )
      .child(body);
  }
}
