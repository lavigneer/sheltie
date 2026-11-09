// The Work sidebar's selection, folds and confirm (src/nav.js).
import assert from "node:assert/strict";
import { test } from "node:test";

const { CONFIRM_MS, Nav } = await import("../src/nav.js");

const row = (path, steps = 0, active = false) => ({
  path,
  steps: Array.from({ length: steps }, (_, i) => ({ id: `s${i}` })),
  active,
});

// The selection workView (work-rows.js) would make of `nav`'s pick.
const at = (nav, rows, active) => {
  const p = nav.picked(active);
  const i = p ? rows.findIndex((r) => r.path === p.path) : -1;
  if (i < 0)
    return [
      Math.max(
        0,
        rows.findIndex((r) => r.active),
      ),
      0,
    ];
  return [i, Math.min(p.step, Math.max(0, rows[i].steps.length - 1))];
};
const move = (nav, rows, active, c) =>
  nav.move(rows, ...at(nav, rows, active), active, c);

test("move: next/prev cycle rows, step-next/step-prev cycle steps", () => {
  const nav = new Nav();
  const rows = [row("a"), row("b", 3)];
  assert.equal(nav.picked(null), null);
  move(nav, rows, null, "prev");
  assert.deepEqual(at(nav, rows, null), [1, 0]);
  move(nav, rows, null, "step-prev");
  assert.deepEqual(at(nav, rows, null), [1, 2]);
  move(nav, rows, null, "step-next");
  assert.deepEqual(at(nav, rows, null), [1, 0]);
  move(nav, rows, null, "next");
  assert.deepEqual(at(nav, rows, null), [0, 0]);
  move(nav, rows, null, "step-next"); // no steps: nothing to move to
  assert.deepEqual(at(nav, rows, null), [0, 0]);
});

test("picked: a focus change drops the pick, for good", () => {
  const nav = new Nav();
  const rows = [row("a", 0, true), row("b")];
  move(nav, rows, "A", "next");
  assert.equal(nav.picked("A").path, "b");
  assert.equal(nav.picked("C"), null);
  assert.equal(nav.picked("A"), null);
});

test("fold: folding the group holding the pick moves it to the hub", () => {
  const nav = new Nav();
  const rows = [row("/r"), row("/r/w1", 2), row("/x")];
  move(nav, rows, null, "next");
  move(nav, rows, null, "step-next");
  assert.deepEqual(nav.picked(null), { path: "/r/w1", step: 1, active: null });
  nav.fold("/r", ["/r/w1"]);
  assert.ok(nav.isFolded("/r"));
  assert.deepEqual(nav.picked(null), { path: "/r", step: 0, active: null });
  // The hub stays selectable and the pick moves on from it.
  const folded = [row("/r"), row("/x")];
  move(nav, folded, null, "next");
  assert.equal(nav.picked(null).path, "/x");
  nav.fold("/r", []);
  assert.ok(!nav.isFolded("/r"));
});

test("fold: a pick elsewhere, or on the hub itself, is kept", () => {
  const nav = new Nav();
  const rows = [row("/r"), row("/r/w1"), row("/x")];
  move(nav, rows, null, "prev"); // /x
  nav.fold("/r", ["/r/w1"]);
  assert.equal(nav.picked(null).path, "/x");
  nav.fold("/r", []);
  move(nav, rows, null, "next"); // /r
  nav.fold("/r", ["/r/w1"]);
  assert.equal(nav.picked(null).path, "/r");
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
