import assert from "node:assert/strict";
import { test } from "node:test";
import { requested, ticketNamed } from "../src/start.js";

test("requested takes keys or { ticket, repo }", () => {
  assert.deepEqual(
    requested({ tickets: ["WEB-1", { ticket: " #2 ", repo: "acme/web" }] }),
    [
      { ticket: "WEB-1", repo: null },
      { ticket: "#2", repo: "acme/web" },
    ],
  );
  assert.throws(() => requested({}), /expected/);
  assert.throws(() => requested({ tickets: [{ repo: "x" }] }), /not a ticket/);
});

test("ticketNamed matches a key, or a label only when it's unique", () => {
  const a = { key: "acme/web#12", label: "web#12" };
  const b = { key: "acme/api#12", label: "#12" };
  const c = { key: "other/api#12", label: "#12" };
  assert.equal(ticketNamed("ACME/WEB#12", [a, b]), a);
  assert.equal(ticketNamed("web#12", [a, b]), a);
  assert.equal(ticketNamed("#12", [a, b]), b);
  assert.equal(ticketNamed("#12", [a, b, c]), null);
  assert.equal(ticketNamed("WEB-9", [a]), null);
});
