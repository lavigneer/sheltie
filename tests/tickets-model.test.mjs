// The Tickets popup's state (#305): which phase the data load is in, what each
// phase knows, and the moves between them, with no View.
import assert from "node:assert/strict";
import { test } from "node:test";

const m = await import("../src/tickets-model.js");

const at = (phase, fields = {}) => ({ phase, gen: 1, ...fields });
const work = (key, n) =>
  new Map([[key, Array.from({ length: n }, () => ({}))]]);

test("Tickets model: a load moves tickets -> listed -> local -> linked -> ready", () => {
  let d = m.reloading(1);
  assert.deepEqual(d, { phase: "tickets", gen: 1 });
  d = m.advance(d, "listed", {
    tickets: [],
    repos: [],
    here: null,
    work: new Map(),
  });
  d = m.advance(d, "local", { work: new Map() });
  d = m.advance(d, "linked", { linked: new Map() });
  d = m.advance(d, "ready", { work: new Map() });
  assert.equal(d.phase, "ready");
  assert.equal(d.gen, 1, "the load's gen carries through");
});

test("Tickets model: a move the table doesn't allow throws", () => {
  assert.throws(() => m.advance(at("tickets"), "local"), /tickets -> local/);
  assert.throws(() => m.advance(at("listed"), "ready"), /listed -> ready/);
  assert.throws(() => m.advance(at("ready"), "failed"), /ready -> failed/);
  assert.throws(() => m.advance(at("failed"), "listed"), /failed -> listed/);
});

test("Tickets model: a failure keeps what the load had, and says where it stopped", () => {
  const shown = [{ key: "A-1" }];
  // Before the list: the list on screen before a reload stays; nothing else is known.
  const early = m.loadFailed(at("tickets"), { shown, error: "x" });
  assert.equal(early.phase, "failed");
  assert.equal(early.from, "tickets");
  assert.deepEqual(early.tickets, shown);
  assert.deepEqual(early.repos, []);
  assert.equal(early.here, null);
  assert.equal(m.localKnown(early), false);

  // After the list, before local work: still nothing known about a ticket's work.
  const listedFailed = m.loadFailed(
    at("listed", {
      tickets: [{ key: "A-2" }],
      repos: [],
      here: "/r",
      work: new Map(),
    }),
    { shown, error: "x" },
  );
  assert.equal(listedFailed.from, "listed");
  assert.deepEqual(
    listedFailed.tickets,
    [{ key: "A-2" }],
    "the new list wins over the shown one",
  );
  assert.equal(listedFailed.here, "/r");
  assert.equal(m.localKnown(listedFailed), false);
});

test("Tickets model: a failure after local work keeps it, so the ticket's screen still opens", () => {
  const local = work("A-1", 1);
  const failed = m.loadFailed(
    at("local", { tickets: [], repos: [], here: null, work: local }),
    {
      shown: undefined,
      error: "PR lookup failed",
    },
  );
  assert.equal(failed.from, "local");
  assert.equal(failed.work, local);
  assert.equal(m.localKnown(failed), true);
  assert.equal(
    m.noWork(failed, "A-1"),
    false,
    "its worktree is known, so it isn't fresh",
  );
});

test("Tickets model: localKnown is true from local on, and for a failure after it", () => {
  assert.equal(m.localKnown(at("tickets")), false);
  assert.equal(m.localKnown(at("listed")), false);
  for (const phase of ["local", "linked", "ready"])
    assert.equal(m.localKnown(at(phase)), true, phase);
});

test("Tickets model: noWork: none once ready, or once linked with none; never while local", () => {
  assert.equal(m.noWork(at("ready", { work: new Map() }), "A-1"), true);
  assert.equal(m.noWork(at("ready", { work: work("A-1", 1) }), "A-1"), false);
  assert.equal(
    m.noWork(at("linked", { work: new Map(), linked: new Map() }), "A-1"),
    true,
  );
  assert.equal(
    m.noWork(
      at("linked", { work: new Map(), linked: new Map([["A-1", [{}]]]) }),
      "A-1",
    ),
    false,
    "a PR its tracker links is work, whose details aren't in yet",
  );
  // Local work alone can't say there's none: its PRs are still being looked up.
  assert.equal(m.noWork(at("local", { work: new Map() }), "A-1"), false);
  assert.equal(m.noWork(at("listed", { work: new Map() }), "A-1"), false);
});

test("Tickets model: a reload carries nothing over: the list empties until it's back", () => {
  assert.deepEqual(m.reloading(2), { phase: "tickets", gen: 2 });
});

test("Tickets model: action shapes", () => {
  assert.deepEqual(m.idleAction(), { phase: "idle" });
  assert.deepEqual(m.runningAction("Creating…"), {
    phase: "running",
    message: "Creating…",
  });
  assert.deepEqual(m.failedAction("boom"), { phase: "failed", error: "boom" });
});
