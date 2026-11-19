// What the Reviews sidebar shows (reviews-rows.js), without drawing it.
import assert from "node:assert/strict";
import { test } from "node:test";

const { reviewsView, waitTone, WARN_MS, LATE_MS } = await import(
  "../src/reviews-rows.js"
);

const NOW = Date.parse("2026-03-10T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const pr = (n, more = {}) => ({
  slug: "me/app",
  number: n,
  title: `A rather long title for PR ${n}`,
  author: "bob",
  requestedAt: ago(60_000),
  additions: 3,
  deletions: 1,
  url: `https://example.test/${n}`,
  ...more,
});
const view = (over = {}) =>
  reviewsView({
    queue: [pr(5)],
    reviewed: [],
    worktreeOf: () => null,
    width: 400,
    now: NOW,
    ...over,
  });

test("waitTone: dim, then working, then blocked as the wait grows", () => {
  assert.equal(waitTone(0), "dim");
  assert.equal(waitTone(WARN_MS - 1), "dim");
  assert.equal(waitTone(WARN_MS), "working");
  assert.equal(waitTone(LATE_MS - 1), "working");
  assert.equal(waitTone(LATE_MS), "blocked");
});

test("a row: the full title on line 1 with its age, the rest on the sub-line", () => {
  const [r] = view({ queue: [pr(5, { requestedAt: ago(2 * LATE_MS) })] }).rows;
  assert.equal(r.title, "A rather long title for PR 5");
  assert.equal(r.age, "2d");
  assert.equal(r.ageTone, "blocked");
  assert.equal(r.sub, "app #5 · bob · +3 −1");
  assert.equal(r.done, false);
});

test("narrow, the sub-line drops the size, then the author; the title stays", () => {
  const sub = (width) => view({ width }).rows[0].sub;
  assert.equal(sub(260), "app #5 · bob");
  assert.equal(sub(180), "app #5");
  assert.equal(
    view({ width: 180 }).rows[0].title,
    "A rather long title for PR 5",
  );
});

test("a PR with a review worktree offers ✓; reviewed ones come after, quieter", () => {
  const v = view({
    worktreeOf: () => ({ path: "/wt" }),
    reviewed: [{ slug: "me/app", number: 9, title: "Old one" }],
  });
  assert.deepEqual(
    v.rows.map((r) => [r.key, r.done, r.reviewed]),
    [
      ["me/app-5", true, false],
      ["me/app-9", true, true],
    ],
  );
  const done = v.rows[1];
  assert.equal(done.age, "reviewed");
  assert.equal(done.ageTone, "dim");
  assert.equal(done.sub, "app #9");
  assert.equal(done.pr.url, "https://github.com/me/app/pull/9");
});
