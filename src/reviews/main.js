// Reviews: the PRs in your repos (localRepos) that request your review, oldest
// request first (prs.js reviewQueue). A row: repo, #number, title, author,
// how long it has waited, and its size. Click to open it in the browser.
// Refreshed as often as the Work sidebar's PRs (PR_MS), and with ↻.

import { h_flex, v_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { theme } from "herdr";
import { C, configReady } from "./config.js";
import { localRepos } from "./git.js";
import { openUrl } from "./lib.js";
import { reviewQueue, reviewRequests } from "./prs.js";
import { band, RAIL, resize } from "./sidebar.js";
import { Cache, serial } from "./watch.js";
import { PR_MS, RETRY_MS } from "./work.js";

// "3d", "5h", "12m": how long ago `iso` was.
export function age(iso, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  return m >= 1440
    ? `${Math.floor(m / 1440)}d`
    : m >= 60
      ? `${Math.floor(m / 60)}h`
      : `${m}m`;
}

export default class Reviews extends View {
  init(_props, cx) {
    this.width = null;
    // One entry, "queue": the last good queue survives a failed refresh.
    this.cache = new Cache({ retryMs: RETRY_MS });
    this.refresh = serial(async (cx) => {
      await configReady();
      await this.cache.refresh("queue", async () => {
        const [repos, data] = await Promise.all([
          localRepos(),
          reviewRequests(),
        ]);
        return reviewQueue(data, repos.map((r) => r.slug).filter(Boolean));
      });
      cx.notify();
    });
    this.refresh(cx);
    cx.timer.every(PR_MS, (cx) => this.refresh(cx));
  }

  render(_cx) {
    const t = theme();
    const rail = band(this.width, [["rail", RAIL]]) === "rail";
    const entry = this.cache.get("queue");
    const queue = entry?.value ?? [];
    const failed = entry?.state === "failed";
    const message = (text, color) =>
      div().px(14).py(4).text_size(11).text_color(color).child(text);

    const row = (r) =>
      h_flex()
        .id(`review-${r.slug}-${r.number}`)
        .px(14)
        .h(20)
        .gap(6)
        .items_center()
        .text_size(12.5)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip(`${r.slug}#${r.number} by ${r.author}\n${r.title}`)
        .on_click((_e, _cx) => openUrl(r.url))
        .child(
          div()
            .flex_none()
            .text_color(t.dim)
            .child(`${r.slug.split("/")[1]} #${r.number}`),
        )
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_color(t.foreground)
            .child(r.title),
        )
        .child(
          div().flex_none().text_size(11).text_color(t.dim).child(r.author),
        )
        .child(
          div()
            .flex_none()
            .text_size(11)
            .text_color(t.muted)
            .child(age(r.requestedAt)),
        )
        .child(
          div()
            .flex_none()
            .text_size(11)
            .text_color(t.dim)
            .child(`+${r.additions} −${r.deletions}`),
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
          .child(entry ? `Reviews (${queue.length})` : "Reviews"),
      )
      .child(
        div()
          .id("reviews-refresh")
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
            this.refresh(cx, true);
          })
          .child("↻"),
      );

    const body = C.problem
      ? message(C.problem, t.blocked)
      : !entry
        ? message("Looking for review requests…", t.dim)
        : v_flex()
            .pb(6)
            .children(queue.map(row))
            .when(!queue.length && !failed, (el) =>
              el.child(message("Nothing awaits your review", t.dim)),
            )
            .when(failed, (el) =>
              el.child(message("Couldn't ask GitHub; retrying", t.blocked)),
            );

    return v_flex()
      .id("reviews")
      .size_full()
      .min_h(0)
      .on_size_change((size, cx) => {
        if (resize(this, size.width, (w) => band(w, [["rail", RAIL]])))
          cx.notify();
      })
      .child(
        rail
          ? div()
              .id("reviews-rail")
              .py(6)
              .flex()
              .justify_center()
              .text_size(9.5)
              .text_color(t.dim)
              .tooltip(
                queue.length
                  ? queue
                      .map((r) => `${r.slug}#${r.number} ${r.title}`)
                      .join("\n")
                  : "No reviews awaiting you",
              )
              .child(entry ? `R ${queue.length}` : "…")
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
