// TicketsModel's actions (#324) with fake sources, no View: starting in a repo,
// starting marked tickets in their suggested repos, ad-hoc work, marking, and
// what a failure records and shows.
import assert from "node:assert/strict";
import { test } from "node:test";

const { TicketsModel } = await import("../src/tickets-model.js");

const REPO = { slug: "acme/web", path: "/src/web", name: "web" };
const ticket = (/** @type {string} */ key) => ({
  key,
  label: `#${key}`,
  summary: "",
});

// A model whose data is loaded to `phase`, with three tickets. `failing`: the
// keys whose prepare throws; `skip`: the key startAll leaves with open work.
function setup({ phase = "ready", failing = new Set(), skip = "skip" } = {}) {
  const st = { opened: [], notes: [], records: [], prepared: [], adhoc: [] };
  const model = new TicketsModel({
    sources: {
      prepare: async (/** @type {any} */ t, /** @type {any} */ repo, opts) => {
        opts.onStep?.(`Starting ${t.label}…`);
        if (failing.has(t.key)) throw new Error(`no ${t.key}\nmore`);
        st.prepared.push([t.key, repo.slug]);
        return { name: t.label, folder: `/wt/${t.key}`, task: "task" };
      },
      startAll: async (/** @type {any[]} */ entries) => {
        const results = entries.map(({ ticket: t }) =>
          t.key === skip
            ? {
                ticket: t.key,
                label: t.label,
                status: "skipped",
                why: "open work",
              }
            : { ticket: t.key, label: t.label, status: "started" },
        );
        const spaces = entries
          .filter(({ ticket: t }) => t.key !== skip)
          .map(({ ticket: t }) => ({ name: t.label, folder: `/wt/${t.key}` }));
        return { results, spaces };
      },
      prepareAdhoc: async (/** @type {string} */ description) => {
        if (description === "") throw new Error("ad-hoc work: no branch name");
        st.adhoc.push(description);
        return { name: "adhoc", folder: "/wt/adhoc", task: null };
      },
      open: (/** @type {any[]} */ list) => st.opened.push(...list),
      notify: (/** @type {any} */ n) => st.notes.push(n),
      record: (/** @type {any[]} */ ...a) => st.records.push(a),
    },
  });
  model.setData({
    phase,
    gen: 1,
    tickets: [ticket("A-1"), ticket("A-2"), ticket(skip)],
    repos: [REPO],
    here: null,
    work: new Map(),
    linked: new Map(),
  });
  return { model, st };
}

test("start in a repo prepares each ticket there, opens their spaces, and goes idle", async () => {
  const { model, st } = setup();
  const seen = [];
  await model.start([ticket("A-1"), ticket("A-2")], REPO, {
    changed: () =>
      seen.push(
        model.action.phase === "running"
          ? model.action.message
          : model.action.phase,
      ),
  });
  assert.deepEqual(st.prepared, [
    ["A-1", "acme/web"],
    ["A-2", "acme/web"],
  ]);
  assert.deepEqual(
    st.opened.map((s) => s.name),
    ["#A-1", "#A-2"],
  );
  assert.equal(model.action.phase, "idle");
  assert.equal(seen[0], "Creating worktrees in acme/web…");
  assert.ok(seen.includes("Starting #A-2…"), "each step is told");
  assert.equal(seen.at(-1), "idle");
});

test("start with no repo: each in its suggested repo, the skipped told, and the marks cleared", async () => {
  const { model, st } = setup();
  model.mark(ticket("A-1"));
  model.mark(ticket("skip"));
  await model.startMarked();
  assert.deepEqual(
    st.opened.map((s) => s.name),
    ["#A-1"],
  );
  assert.deepEqual(st.notes, [
    {
      title: "1 of 2 tickets not started",
      body: "#skip: open work",
      level: "warning",
    },
  ]);
  assert.equal(model.marked.size, 0);
  assert.equal(model.action.phase, "idle");
});

test("start with no repo waits for the tickets' work to load", async () => {
  const { model, st } = setup({ phase: "linked" });
  model.mark(ticket("A-1"));
  await model.startMarked();
  assert.deepEqual(model.action, {
    phase: "failed",
    error: "Still loading tickets' work, try again",
  });
  assert.deepEqual(st.opened, []);
  assert.deepEqual(st.records, [], "waiting isn't a failure to record");
});

test("a failed start is recorded and shown, opens nothing, and the next start works", async () => {
  const { model, st } = setup({ failing: new Set(["A-1"]) });
  await model.start([ticket("A-1")], REPO);
  assert.deepEqual(st.records[0].slice(0, 2), [
    "tickets",
    "Creating worktree for #A-1 in acme/web…",
  ]);
  assert.deepEqual(model.action, { phase: "failed", error: "no A-1" });
  assert.deepEqual(st.opened, []);

  await model.start([ticket("A-2")], REPO);
  assert.deepEqual(
    st.opened.map((s) => s.name),
    ["#A-2"],
  );
  assert.equal(model.action.phase, "idle");
});

test("ad-hoc work starts in the repo it's given, and a failure is shown", async () => {
  const { model, st } = setup();
  await model.startAdhoc("fix the login", REPO);
  assert.deepEqual(st.adhoc, ["fix the login"]);
  assert.deepEqual(
    st.opened.map((s) => s.name),
    ["adhoc"],
  );
  assert.equal(model.action.phase, "idle");

  await model.startAdhoc("", REPO);
  assert.equal(st.records.at(-1)[1], "Creating worktree in acme/web…");
  assert.deepEqual(model.action, {
    phase: "failed",
    error: "ad-hoc work: no branch name",
  });
});

test("mark toggles a ticket, and does nothing while an action runs", async () => {
  const { model } = setup();
  const a = ticket("A-1");
  model.mark(a);
  assert.deepEqual([...model.marked], ["A-1"]);
  model.mark(a);
  assert.equal(model.marked.size, 0);

  let finish = () => {};
  const held = new Promise((resolve) => (finish = resolve));
  const running = model.act("Holding…", () => held);
  model.mark(a);
  assert.equal(model.marked.size, 0);
  finish();
  await running;
  assert.equal(model.action.phase, "idle");
});

test("one action at a time: a second one doesn't run", async () => {
  const { model } = setup();
  let finish = () => {};
  const held = new Promise((resolve) => (finish = resolve));
  const first = model.act("one", () => held);
  let ran = false;
  await model.act("two", async () => {
    ran = true;
  });
  assert.equal(ran, false);
  assert.equal(model.action.message, "one");
  finish();
  await first;
});

test("a failed load is recorded, and the data says where it stopped", () => {
  const { model, st } = setup({ phase: "listed" });
  model.failLoad(new Error("offline\nmore"), undefined);
  assert.equal(model.data.phase, "failed");
  assert.equal(model.data.error, "offline");
  assert.equal(model.data.from, "listed");
  assert.deepEqual(st.records[0].slice(0, 2), ["tickets", "load"]);
});

test("clearFailure goes back to idle, and leaves a running action alone", async () => {
  const { model } = setup({ failing: new Set(["A-1"]) });
  await model.start([ticket("A-1")], REPO);
  assert.equal(model.action.phase, "failed");
  model.clearFailure();
  assert.equal(model.action.phase, "idle");

  let finish = () => {};
  const held = new Promise((resolve) => (finish = resolve));
  const running = model.act("busy", () => held);
  model.clearFailure();
  assert.equal(model.action.phase, "running");
  finish();
  await running;
});
