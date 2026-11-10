// Reviews: the PRs in your repos (localRepos) that request your review, oldest
// request first (prs.js reviewQueue). A row: repo, #number, title, author,
// how long it has waited, and its size. Click to start the review: the PR
// checked out in a review worktree, in its own space with agent.reviewTask
// (start.js prepareReview); ↗ opens it in the browser. A row with a review
// worktree has ✓ (Done reviewing: start.js finishReview); reviewed PRs keep a
// row while their worktree stays, and one whose PR merged or closed is torn
// down on the next refresh (sweepReviews).
// Refreshed as often as the Work sidebar's PRs (PR_MS), and with ↻.

import { h_flex, v_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { notify, theme } from "herdr";
import { C, configReady } from "./config.js";
import { localRepos, sameSlug } from "./git.js";
import { openUrl } from "./lib.js";
import { reviewQueue, reviewRequests } from "./prs.js";
import { band, RAIL, resize } from "./sidebar.js";
import {
  allReviewWorktrees,
  errorText,
  finishReview,
  openSpaces,
  prepareReview,
  sweepReviews,
} from "./start.js";
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
    this.repos = [];
    this.worktrees = []; // allReviewWorktrees, after sweeping
    this.reviewed = []; // worktrees of PRs no longer in the queue, still open
    this.warned = new Set(); // paths whose automatic teardown was refused

    // One start at a time, so a double click can't check out twice.
    this.starting = false;
    this.start = (cx, r) => {
      if (this.starting) return;
      this.starting = true;
      cx.spawn(() => this.startReview(r));
    };
    // One entry, "queue": the last good queue survives a failed refresh.
    this.cache = new Cache({ retryMs: RETRY_MS });
    this.refresh = serial(async (cx) => {
      await configReady();
      await this.cache.refresh("queue", async () => {
        const [repos, data] = await Promise.all([
          localRepos(),
          reviewRequests(),
        ]);
        this.repos = repos;
        return reviewQueue(data, repos.map((r) => r.slug).filter(Boolean));
      });
      await this.sweep().catch(() => {});
      cx.notify();
    });
    this.refresh(cx);
    cx.timer.every(PR_MS, (cx) => this.refresh(cx));
  }

  // Tears down review worktrees whose PR merged or closed; a refusal is told
  // once per worktree.
  async sweep() {
    const queue = this.cache.get("queue")?.value ?? [];
    const all = await allReviewWorktrees(this.repos);
    const { kept, refused } = await sweepReviews(all, queue);
    for (const w of refused)
      if (!this.warned.has(w.path)) {
        this.warned.add(w.path);
        notify({
          title: `${w.slug}#${w.number}: review worktree kept`,
          body: w.why,
          level: "warning",
        });
      }
    const gone = new Set(all.map((w) => w.path));
    for (const w of kept) gone.delete(w.path);
    this.worktrees = all.filter((w) => !gone.has(w.path));
    const queued = (w) =>
      queue.some((r) => r.number === w.number && sameSlug(r.slug, w.slug));
    this.reviewed = kept.filter((w) => !queued(w));
  }

  worktreeOf(r) {
    return this.worktrees.find(
      (w) => w.number === r.number && sameSlug(w.slug, r.slug),
    );
  }

  async doneReviewing(w, cx) {
    try {
      await finishReview(w.repo, w);
      this.worktrees = this.worktrees.filter((x) => x.path !== w.path);
      this.reviewed = this.reviewed.filter((x) => x.path !== w.path);
    } catch (e) {
      notify({
        title: `${w.slug}#${w.number}: couldn't tear down the review`,
        body: errorText(e),
        level: "error",
      });
    }
    cx.notify();
  }

  async startReview(r) {
    try {
      const repo = this.repos.find((x) => x.path && sameSlug(x.slug, r.slug));
      if (!repo) throw new Error(`${r.slug} isn't checked out here`);
      openSpaces([await prepareReview(r, repo)]);
    } catch (e) {
      notify({
        title: `${r.slug}#${r.number}: couldn't start the review`,
        body: errorText(e),
        level: "error",
      });
    } finally {
      this.starting = false;
    }
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
        .tooltip(
          `${r.slug}#${r.number} by ${r.author}\n${r.title}\nClick to start reviewing`,
        )
        .on_click((_e, cx) => this.start(cx, r))
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
            .child(r.requestedAt ? age(r.requestedAt) : ""),
        )
        .child(
          div()
            .flex_none()
            .text_size(11)
            .text_color(t.dim)
            .child(
              r.additions == null ? "" : `+${r.additions} −${r.deletions}`,
            ),
        )
        .child(
          div()
            .id(`review-open-${r.slug}-${r.number}`)
            .flex_none()
            .px(3)
            .rounded(4)
            .text_size(11)
            .text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Open in browser")
            .on_click((_e, cx) => {
              cx.stop_propagation();
              openUrl(r.url);
            })
            .child("↗"),
        )
        .when(Boolean(this.worktreeOf(r)), (el) =>
          el.child(
            div()
              .id(`review-done-${r.slug}-${r.number}`)
              .flex_none()
              .px(3)
              .rounded(4)
              .text_size(11)
              .text_color(t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip("Done reviewing: close its space, remove the worktree")
              .on_click((_e, cx) => {
                cx.stop_propagation();
                const w = this.worktreeOf(r);
                if (w) cx.spawn((cx) => this.doneReviewing(w, cx));
              })
              .child("✓"),
          ),
        );
    // A reviewed PR whose worktree is still here.
    const reviewedRow = (w) =>
      row({
        slug: w.slug,
        number: w.number,
        url: w.url || `https://github.com/${w.slug}/pull/${w.number}`,
        title: w.title || "(reviewed)",
        author: "reviewed",
        requestedAt: null,
        additions: null,
      });

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
            .children(this.reviewed.map(reviewedRow))
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
