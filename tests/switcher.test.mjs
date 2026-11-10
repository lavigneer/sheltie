// The Work | Reviews strip (switcher.js): the active tab comes from the
// layout's `current` prop, the count from what the Reviews mod published.
import assert from "node:assert/strict";
import { test } from "node:test";
import { switcherTabs } from "../src/switcher.js";

const view = (tabs) => tabs.map((t) => `${t.active ? "*" : ""}${t.label}`);

test("the current prop picks the active tab", () => {
  assert.deepEqual(view(switcherTabs("sheltie", 2)), ["*Work", "Reviews 2"]);
  assert.deepEqual(view(switcherTabs("review", 2)), ["Work", "*Reviews 2"]);
  assert.deepEqual(
    switcherTabs("review").map((t) => t.layout),
    ["sheltie", "review"],
  );
});

test("no count before the queue has loaded; zero once it has", () => {
  assert.deepEqual(view(switcherTabs("sheltie", null)), ["*Work", "Reviews"]);
  assert.deepEqual(view(switcherTabs("sheltie", undefined)), [
    "*Work",
    "Reviews",
  ]);
  assert.deepEqual(view(switcherTabs("sheltie", 0)), ["*Work", "Reviews 0"]);
});
