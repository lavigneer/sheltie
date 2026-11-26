// The Usage sidebar (src/usage/main.js, loaded as built in mods/usage/)
// through the herdr stub. Its usage read and its plan-limits read each guard
// only their own in-flight state, so overlapping calls don't block each other.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sandbox } from "./fake-tools.mjs";

// No agents, so no logs or claude to read; prices from a file that isn't there.
sandbox({
  settings: {
    usage: { agents: [], prices: "file:///nonexistent/usage-prices.json" },
  },
});

const { mount } = await import("./mod-driver.mjs");
const { default: Usage } = await import("../mods/usage/main.js");

// A cx whose reads are held (not run) until the test runs them.
function holding(cx) {
  const held = [];
  return { held, cx: { ...cx, spawn: (f) => held.push(f), notify() {} } };
}

test("Usage: overlapping reads guard only their own flag", async () => {
  const d = mount(Usage);
  const view = d.view;
  // Both first reads start in init.
  assert.equal(view.state.phase, "loading");
  assert.equal(view.limits.phase, "loading");
  await d.until(
    () => view.state.phase !== "loading" && view.limits.phase !== "loading",
    "the first reads",
  );

  const { held, cx } = holding(d.cx);
  view.readLimits(cx);
  assert.equal(view.limits.phase, "loading");
  assert.equal(held.length, 1);
  // A limits read already in flight is not started again.
  view.readLimits(cx);
  assert.equal(held.length, 1);
  // A usage read starts while the limits read is in flight.
  view.load(cx, 0);
  assert.equal(view.state.phase, "loading");
  assert.equal(held.length, 2);
  // A usage read already in flight is not started again.
  view.load(cx, 0);
  assert.equal(held.length, 2);

  // The limits read finishing clears only its own flag.
  await held[0](d.cx);
  assert.equal(view.limits.phase, "ready");
  assert.deepEqual(view.limits.list, []);
  assert.equal(view.state.phase, "loading");
  // Then the usage read.
  await held[1](d.cx);
  assert.notEqual(view.state.phase, "loading");
  assert.notEqual(view.limits.phase, "loading");

  // Both are free again, so each can be read again.
  view.readLimits(cx);
  view.load(cx, 0);
  assert.equal(held.length, 4);
});
