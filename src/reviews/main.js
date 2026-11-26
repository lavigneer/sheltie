// Reviews: the PRs in your repos (localRepos) that request your review, oldest
// request first (prs.js reviewQueue). A row: repo, #number, title, author,
// how long it has waited (the row's loud element, toned by the wait), and
// its size; reviews-rows.js decides what a row shows. Click to start the review: the PR
// checked out in a review worktree, in its own space with agent.reviewTask
// (start.js prepareReview); ↗ opens it in the browser. A row with a review
// worktree has ✓ (Done reviewing: start.js finishReview); reviewed PRs keep a
// row while their worktree stays, and one whose PR merged or closed is torn
// down on the next refresh (sweepReviews).
// Publishes the queue length (switcher.js REVIEW_COUNT) for the layouts mod.
// Refreshed as often as the Work sidebar's PRs (PR_MS), and with ↻.

import { h_flex, v_flex } from "gpui-base";
import { div, svg, View } from "gpui-kit";
import { setShared, theme } from "herdr";
import { C } from "./config.js";
import { openUrl } from "./lib.js";
import { CONFIRM_MS, Nav } from "./nav.js";
import { PR_MS } from "./polling.js";
import { ReviewsModel } from "./reviews-model.js";
import { fit, reviewsView } from "./reviews-rows.js";
import { resize } from "./sidebar.js";
import { REVIEW_COUNT } from "./switcher.js";
import { serial } from "./watch.js";

export { age } from "./reviews-rows.js";

export default class Reviews extends View {
  /** @type {number | null} */
  width = null;
  /** @type {ReturnType<typeof serial>} */
  refresh = /** @type {any} */ (undefined);
  /** @type {ReviewsModel} */
  model = /** @type {any} */ (undefined);
  /** @type {Nav} */
  confirm = /** @type {any} */ (undefined);
  /** @type {(cx: any, r: any) => any} */
  start = /** @type {any} */ (undefined);
  init(/** @type {any} */ _props, /** @type {any} */ cx) {
    /** @type {number | null} */
    this.width = null;
    this.model = new ReviewsModel(); // queue, worktrees, actions (reviews-model.js)
    // Done reviewing closes a space and removes a worktree: like Work's Finish,
    // it asks for a second click (nav.js; workflow.confirmFinish).
    this.confirm = new Nav();
    this.start = (cx, r) => cx.spawn(() => this.model.start(r));
    // The queue length for the layouts mod's Reviews tab: none until loaded.
    setShared(REVIEW_COUNT, null);
    this.refresh = serial(async (cx, force) => {
      await this.model.refresh(force);
      if (this.model.count !== null) setShared(REVIEW_COUNT, this.model.count);
      cx.notify();
    });
    this.refresh(cx);
    cx.timer.every(PR_MS, (/** @type {any} */ cx) => this.refresh(cx));
  }

  async doneReviewing(/** @type {any} */ w, /** @type {any} */ cx) {
    await this.model.done(w);
    cx.notify();
  }

  render(/** @type {any} */ _cx) {
    const t = theme();
    const { queue, failed, entry } = this.model;
    const view = reviewsView({
      queue,
      reviewed: this.model.reviewed,
      worktreeOf: (r) => this.model.worktreeOf(r),
      width: this.width,
    });
    const rail = view.span === "rail";
    const tone = (/** @type {any} */ name) => t[name] ?? t.accent;
    const message = (/** @type {any} */ text, /** @type {any} */ color) =>
      div().px(14).py(4).text_size(11).text_color(color).child(text);
    const button = (
      /** @type {any} */ id,
      /** @type {any} */ tip,
      /** @type {any} */ glyph,
      /** @type {any} */ onClick,
    ) =>
      div()
        .id(id)
        .flex_none()
        .px(3)
        .rounded(4)
        .text_size(11)
        .text_color(t.dim)
        .hover((/** @type {any} */ s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(tip)
        .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => {
          cx.stop_propagation();
          onClick(cx);
        })
        .child(glyph);

    // Two lines: the title and its age; then the dim sub-line and the buttons.
    const row = (/** @type {any} */ v) => {
      const r = v.pr;
      return v_flex()
        .id(`review-${v.key}`)
        .px(14)
        .py(3)
        .cursor_pointer()
        .hover((/** @type {any} */ s) => s.bg(t.hover))
        .tooltip(v.tip)
        .on_click((/** @type {any} */ _e, /** @type {any} */ cx) =>
          this.start(cx, r),
        )
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(12.5)
                .text_color(v.reviewed ? t.dim : t.foreground)
                .child(v.title),
            )
            .child(
              div()
                .flex_none()
                .text_size(11)
                .text_color(tone(v.ageTone))
                .when(
                  !v.reviewed && v.ageTone !== "dim",
                  (/** @type {any} */ d) => d.font_semibold(),
                )
                .child(v.age),
            ),
        )
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11)
                .text_color(t.dim)
                .child(v.sub),
            )
            .child(
              button(`review-open-${v.key}`, "Open in browser", "↗", () =>
                openUrl(r.url),
              ),
            )
            .when(v.done, (/** @type {any} */ el) => {
              const w = this.model.worktreeOf(r);
              const armed =
                Boolean(w) && this.confirm.armed(w.path, Date.now());
              return el.child(
                div()
                  .id(`review-done-${v.key}`)
                  .flex_none()
                  .px(3)
                  .rounded(4)
                  .text_size(11)
                  .text_color(armed ? t.blocked : t.dim)
                  .hover((/** @type {any} */ s) =>
                    s.bg(t.hover).text_color(t.foreground),
                  )
                  .tooltip(
                    armed
                      ? "Click again: close its space, remove the worktree"
                      : "Done reviewing: close its space, remove the worktree",
                  )
                  .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => {
                    cx.stop_propagation();
                    // The first click arms it; the second, within CONFIRM_MS, runs.
                    const confirm = C.workflow.confirmFinish !== false;
                    if (
                      !this.confirm.press(w.path, confirm, false, Date.now())
                    ) {
                      cx.timer.after(CONFIRM_MS, (/** @type {any} */ cx) =>
                        cx.notify(),
                      );
                      return cx.notify();
                    }
                    cx.spawn((/** @type {any} */ cx) =>
                      this.doneReviewing(w, cx),
                    );
                  })
                  .child(armed ? "Done?" : "✓"),
              );
            }),
        );
    };

    const refreshing = this.refresh.forcing();
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
          .hover((/** @type {any} */ s) =>
            s.bg(t.hover).text_color(t.foreground),
          )
          .tooltip(refreshing ? "Refreshing…" : "Refresh now")
          .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => {
            cx.stop_propagation();
            this.refresh(cx, true);
          })
          .child(
            refreshing
              ? svg("mods/workspace-chrome/spinner.svg").size(11).spin(900)
              : "↻",
          ),
      );

    const body = C.problem
      ? message(C.problem, t.blocked)
      : !entry
        ? message("Looking for review requests…", t.dim)
        : v_flex()
            .pb(6)
            .children(view.rows.map(row))
            .when(!queue.length && !failed, (/** @type {any} */ el) =>
              el.child(message("Nothing awaits your review", t.dim)),
            )
            .when(failed, (/** @type {any} */ el) =>
              el.child(message("Couldn't ask GitHub; retrying", t.blocked)),
            );

    return v_flex()
      .id("reviews")
      .size_full()
      .min_h(0)
      .on_size_change((/** @type {any} */ size, /** @type {any} */ cx) => {
        if (resize(this, size.width, fit)) cx.notify();
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
