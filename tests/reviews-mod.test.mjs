// The Reviews sidebar (src/reviews/main.js, loaded as built in mods/reviews/)
// through the herdr stub: a real git repo, a fake gh answering the
// review-request search; asserts on what it renders and the run(...) calls
// it makes.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { gitRepo, prNode, reviewNode, sandbox } from "./fake-tools.mjs";

const box = sandbox();
const app = gitRepo(box.root, "app", "me/app");
const state = {
  reviews: [
    reviewNode("me/app", 7, {
      title: "Speed up search",
      createdAt: "2026-01-02T00:00:00Z",
    }),
    reviewNode("me/app", 5, {
      title: "Fix the typo",
      author: { login: "bob" },
      createdAt: "2026-01-01T00:00:00Z",
      additions: 1,
      deletions: 1,
    }),
    // Not a repo checked out here: left out.
    reviewNode("other/lib", 3, { title: "Elsewhere" }),
  ],
  prs: { "pr-5": prNode(5, "pr-5") },
};
box.setState(state);

const { mount, find, findAll } = await import("./mod-driver.mjs");
const { shared } = await import("./herdr-stub.mjs");
const { REVIEW_COUNT } = await import("../src/switcher.js");
const { default: Reviews } = await import("../mods/reviews/main.js");

const ran = (d, name) => d.calls.run.filter((c) => c.name === name);
const reviewPath = (n) => `${app.path}/.worktrees/review-${n}`;
async function ready() {
  const d = mount(Reviews);
  await d.until(() => /Speed up search/.test(d.text()), "the queue");
  return d;
}

test("Reviews: lists the PRs awaiting your review in repos here, oldest request first", async () => {
  const d = await ready();
  const rows = findAll(d.render(), "review-me/app-").map((r) => r.id);
  assert.deepEqual(rows, ["review-me/app-5", "review-me/app-7"]);
  assert.match(d.text(), /Reviews \(2\)/);
  assert.match(d.text(), /app #5 Fix the typo bob/);
  assert.match(d.text(), /\+1 −1/);
  assert.doesNotMatch(d.text(), /Elsewhere/);
  // Published once the refresh (and its sweep) is done.
  await d.until(() => shared(REVIEW_COUNT) === 2, "the count published");
});

test("Reviews: clicking a row checks the PR out in a review worktree and opens its space with the review task", async () => {
  const d = await ready();
  d.click("review-me/app-5");
  const started = await d.until(() => ran(d, "space.new")[0], "space.new");
  assert.deepEqual(started.args, {
    name: "Review app#5",
    folder: reviewPath(5),
    argv: ["claude"],
    task: "/review-pr 5",
  });
  assert.ok(fs.existsSync(reviewPath(5)));
  assert.ok(
    box.ghCalls().some((a) => a.join(" ") === "pr checkout 5"),
    "gh pr checkout 5",
  );
});

test("Reviews: a started review has ✓, which removes its worktree", async () => {
  const d = await ready();
  await d.until(
    () => find(d.render(), "review-done-me/app-5"),
    "✓ on the started review",
  );
  assert.equal(find(d.render(), "review-done-me/app-7"), null);
  d.click("review-done-me/app-5");
  await d.until(
    () => !find(d.render(), "review-done-me/app-5"),
    "✓ gone once done",
  );
  assert.equal(fs.existsSync(reviewPath(5)), false);
});

test("Reviews: ↗ opens the PR in the browser, without starting it", async () => {
  const d = await ready();
  const before = box.opened().length;
  d.click("review-open-me/app-7");
  await d.until(() => box.opened().length > before, "the PR opened");
  assert.equal(box.opened().at(-1), "https://github.com/me/app/pull/7");
  assert.deepEqual(ran(d, "space.new"), []);
});

test("Reviews: says so when nothing awaits your review, or GitHub can't be asked", async (t) => {
  t.after(() => box.setState(state));
  box.setState({ ...state, reviews: [] });
  const d = mount(Reviews);
  await d.until(
    () => /Nothing awaits your review/.test(d.text()),
    "the empty queue",
  );
  await d.until(() => shared(REVIEW_COUNT) === 0, "a count of 0");

  box.setState({ ...state, searchFails: true });
  const f = mount(Reviews);
  await f.until(
    () => /Couldn't ask GitHub; retrying/.test(f.text()),
    "the failure",
  );
});
