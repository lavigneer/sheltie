// The Work sidebar's selection, folds and confirm (src/nav.js).
import assert from "node:assert/strict";
import { test } from "node:test";

const { CONFIRM_MS, Nav } = await import("../src/nav.js");

const row = (path, steps = 0, active = false) => ({
  path,
  steps: Array.from({ length: steps }, (_, i) => ({ id: `s${i}` })),
  active,
});

test("select: the focused space's row by default, else the first", () => {
  const nav = new Nav();
  assert.deepEqual(nav.select([], null), { at: -1, step: 0 });
  assert.deepEqual(nav.select([row("a"), row("b")], null), { at: 0, step: 0 });
  assert.deepEqual(nav.select([row("a"), row("b", 0, true)], "B"), {
    at: 1,
    step: 0,
  });
});

test("move: next/prev cycle rows, step-next/step-prev cycle steps", () => {
  const nav = new Nav();
  const rows = [row("a"), row("b", 3)];
  nav.move(rows, null, "prev");
  assert.deepEqual(nav.select(rows, null), { at: 1, step: 0 });
  nav.move(rows, null, "step-prev");
  assert.deepEqual(nav.select(rows, null), { at: 1, step: 2 });
  nav.move(rows, null, "step-next");
  assert.deepEqual(nav.select(rows, null), { at: 1, step: 0 });
  nav.move(rows, null, "next");
  assert.deepEqual(nav.select(rows, null), { at: 0, step: 0 });
});

test("select: a focus change drops the pick", () => {
  const nav = new Nav();
  const rows = [row("a", 0, true), row("b")];
  nav.move(rows, "A", "next");
  assert.equal(nav.select(rows, "A").at, 1);
  const moved = [row("a"), row("b"), row("c", 0, true)];
  assert.equal(nav.select(moved, "C").at, 2);
  assert.equal(nav.select(rows, "A").at, 0); // stays dropped
});

test("select: the step clamps when the row's steps shrink", () => {
  const nav = new Nav();
  nav.move([row("a", 3)], null, "step-prev");
  assert.deepEqual(nav.select([row("a", 3)], null), { at: 0, step: 2 });
  assert.deepEqual(nav.select([row("a", 2)], null), { at: 0, step: 1 });
  assert.deepEqual(nav.select([row("a")], null), { at: 0, step: 0 });
});

test("fold: folding the group holding the pick moves it to the hub", () => {
  const nav = new Nav();
  const rows = [row("/r"), row("/r/w1", 2), row("/x")];
  nav.move(rows, null, "next");
  nav.move(rows, null, "step-next");
  nav.fold("/r", ["/r/w1"]);
  assert.ok(nav.isFolded("/r"));
  const folded = [row("/r"), row("/x")];
  assert.deepEqual(nav.select(folded, null), { at: 0, step: 0 });
  // The hub stays selectable and the pick moves on from it.
  nav.move(folded, null, "next");
  assert.equal(nav.select(folded, null).at, 1);
  nav.fold("/r", ["/r/w1"]);
  assert.ok(!nav.isFolded("/r"));
});

test("fold: a pick elsewhere, or on the hub itself, is kept", () => {
  const nav = new Nav();
  const rows = [row("/r"), row("/r/w1"), row("/x")];
  nav.move(rows, null, "prev"); // /x
  nav.fold("/r", ["/r/w1"]);
  assert.equal(nav.select([row("/r"), row("/x")], null).at, 1);
  nav.fold("/r", ["/r/w1"]);
  nav.move(rows, null, "next"); // /r
  nav.fold("/r", ["/r/w1"]);
  assert.equal(nav.select([row("/r"), row("/x")], null).at, 0);
});

test("press: a confirm step runs on its second press, until CONFIRM_MS", () => {
  const nav = new Nav();
  assert.equal(nav.press("p:finish", true, true, 0), false);
  assert.deepEqual(nav.confirming(1), {
    id: "p:finish",
    byKey: true,
    until: CONFIRM_MS,
  });
  assert.equal(nav.press("p:finish", true, true, 1), true);
  assert.equal(nav.confirming(2), null);

  assert.equal(nav.press("p:finish", true, false, 10), false);
  assert.equal(nav.confirming(10 + CONFIRM_MS), null); // expired
  assert.equal(nav.press("p:finish", true, false, 10 + CONFIRM_MS), false);

  // Another step asks afresh; a step with no confirm runs and clears it.
  assert.equal(nav.press("q:finish", true, false, 20 + CONFIRM_MS), false);
  assert.equal(nav.confirming(20 + CONFIRM_MS).id, "q:finish");
  assert.equal(nav.press("q:merge", false, false, 21 + CONFIRM_MS), true);
  assert.equal(nav.confirming(22 + CONFIRM_MS), null);
});
