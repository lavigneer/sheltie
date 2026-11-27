// The Tickets popup (src/tickets/main.js, loaded as built in mods/tickets/)
// through the herdr stub: a real git repo, a fake gh, typing and keys sent to
// what it renders; asserts on what it shows and the run(...) calls it makes.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { gitRepo, sandbox } from "./fake-tools.mjs";

const box = sandbox({ settings: { github: { repos: ["me/app"] } } });
const app = gitRepo(box.root, "app", "me/app", ["issue-1"]);
const issues = {
  1: { title: "Fix the login" },
  2: { title: "Add dark mode" },
  3: { title: "Speed up search" },
};
box.setState({ issues });

const { mount, findAll } = await import("./mod-driver.mjs");
const { default: Tickets } = await import("../mods/tickets/main.js");

const wt1 = app.worktree("issue-1");
const ran = (d, name) => d.calls.run.filter((c) => c.name === name);
const branches = () =>
  app.git("branch", "--format=%(refname:short)").split("\n").filter(Boolean);
const rowIds = (d) =>
  findAll(d.render(), "tk-")
    .map((e) => e.id)
    .filter((id) => id !== "tk-back");

// The popup once every ticket's work is known.
async function ready() {
  const d = mount(Tickets);
  await d.until(
    () => d.view.data.phase === "ready" && /Speed up search/.test(d.text()),
    "the tickets and their work",
  );
  return d;
}
// Filters the list down to `text` and presses Enter on the top row.
function enterOn(d, text) {
  d.type(text);
  assert.match(d.text(), new RegExp(text));
  d.submit();
}

test("Tickets: lists the open tickets, with their labels", async () => {
  const d = await ready();
  for (const s of ["#1", "Fix the login", "#2", "Add dark mode", "#3"])
    assert.match(d.text(), new RegExp(s));
});

test("Tickets: typing filters the list, with ad-hoc work last", async () => {
  const d = await ready();
  d.type("dark");
  assert.match(d.text(), /Add dark mode/);
  assert.doesNotMatch(d.text(), /Fix the login/);
  assert.match(d.text(), /Start ad-hoc work: dark/);
  assert.match(rowIds(d).at(-1), /-action$/);
});

test("Tickets: Enter on a fresh ticket with one home starts it there: worktree, space and agent", async () => {
  const d = await ready();
  enterOn(d, "Add dark mode");
  const started = await d.until(() => ran(d, "space.new")[0], "space.new");
  const wt2 = app.worktree("issue-2");
  assert.equal(started.args.folder, wt2);
  assert.equal(started.args.name, "#2");
  assert.deepEqual(started.args.argv, ["claude"]);
  assert.match(started.args.task, /^Work on me\/app#2: Add dark mode/);
  assert.ok(fs.existsSync(wt2));
  assert.ok(branches().includes("issue-2"));
  assert.deepEqual(d.calls.closed, ["overlay-1"]);
});

test("Tickets: Enter on a ticket with work opens its screen; Enter on its worktree opens a space there", async () => {
  const d = await ready();
  enterOn(d, "Fix the login");
  assert.equal(d.view.screen.name, "ticket");
  assert.match(d.text(), /Fix the login/);
  assert.match(d.text(), /worktree/);
  assert.match(d.text(), /Start in another repo…/);
  assert.match(rowIds(d)[0], /-item$/);
  d.submit();
  assert.deepEqual(ran(d, "space.new"), [
    { name: "space.new", args: { name: "#1", folder: wt1, argv: ["claude"] } },
  ]);
  assert.deepEqual(d.calls.closed, ["overlay-1"]);
});

test("Tickets: Backspace in an empty search goes back from a ticket's screen", async () => {
  const d = await ready();
  enterOn(d, "Fix the login");
  d.type("");
  d.key("backspace");
  assert.equal(d.view.screen.name, "list");
  assert.match(d.text(), /Speed up search/);
});

test("Tickets: Backspace on the repo picker goes back to the ticket's screen, with its ticket", async () => {
  const d = await ready();
  enterOn(d, "Fix the login");
  const { key, label } = d.view.screen.ticket;
  d.type("another repo");
  d.submit();
  assert.equal(d.view.screen.name, "pick");
  d.key("backspace");
  assert.equal(d.view.screen.name, "ticket");
  assert.equal(d.view.screen.ticket.key, key);
  assert.equal(d.view.screen.ticket.label, label);
});

test("Tickets: a move the screen graph doesn't declare throws instead of landing", async () => {
  const d = await ready();
  const ticket = { key: "1", label: "#1" };
  assert.throws(
    () => d.view.go({ name: "pick", ticket }, d.cx),
    /no move from list to pick/,
  );
  enterOn(d, "Fix the login");
  assert.throws(
    () => d.view.go({ name: "adhoc", description: "x" }, d.cx),
    /no move from ticket to adhoc/,
  );
  assert.equal(d.view.screen.name, "ticket");
});

test("Tickets: a ticket's screen picks another repo from Start in another repo…", async () => {
  const d = await ready();
  enterOn(d, "Fix the login");
  d.type("another repo");
  d.submit();
  assert.equal(d.view.screen.name, "pick");
  assert.match(d.text(), /Start in me\/app/);
});

test("Tickets: Down / Up move the selection, wrapping", async () => {
  const d = await ready();
  const n = rowIds(d).length;
  assert.equal(d.view.at, 0);
  d.key("down");
  assert.equal(d.view.at, 1);
  d.key("p", { control: true });
  d.key("up");
  assert.equal(d.view.at, n - 1);
});

test("Tickets: ad-hoc work picks a repo, then a worktree on a branch named after it, with the agent told", async () => {
  const d = await ready();
  d.type("tidy the logs");
  d.key("up"); // wraps to the last row: ad-hoc work
  d.submit();
  assert.equal(d.view.screen.name, "adhoc");
  assert.match(d.text(), /Ad-hoc: tidy the logs/);
  d.type("me/app");
  d.submit();
  const started = await d.until(() => ran(d, "space.new")[0], "space.new");
  assert.match(started.args.folder, /tidy-the-logs/);
  assert.ok(started.args.task?.includes("tidy the logs"));
  assert.ok(branches().some((b) => /tidy-the-logs/.test(b)));
});

test("Tickets: Tab marks tickets; Enter then starts each in its own space", async () => {
  const d = await ready();
  d.type("Speed up search");
  d.action("tickets::mark");
  d.type("");
  assert.match(d.text(), /1 marked/);
  assert.match(d.text(), /✓/);
  d.submit();
  await d.until(() => ran(d, "space.new").length === 1, "space.new");
  assert.equal(ran(d, "space.new")[0].args.folder, app.worktree("issue-3"));
  assert.ok(fs.existsSync(app.worktree("issue-3")));
});

test("Tickets: Ctrl+O opens the selected ticket in the browser", async () => {
  const d = await ready();
  const before = box.opened().length;
  d.type("Fix the login");
  d.key("o", { control: true });
  await d.until(() => box.opened().length > before, "the ticket opened");
  assert.equal(box.opened().at(-1), "https://github.com/me/app/issues/1");
});

test("Tickets: a failed load shows its error; Ctrl+R retries it", async () => {
  box.setState({ issues, issuesFails: true });
  try {
    const d = mount(Tickets);
    await d.until(() => d.view.data.phase === "failed", "the load to fail");
    assert.equal(d.view.data.from, "tickets");
    assert.match(d.text(), /Ctrl\+R to retry/);
  } finally {
    box.setState({ issues });
  }
  const d = mount(Tickets);
  d.key("r", { control: true });
  await d.until(
    () => d.view.data.phase === "ready" && /Speed up search/.test(d.text()),
    "the retried load",
  );
});

test("Tickets: a reload supersedes a load still in flight; only the newer one's results are kept", async () => {
  const d = mount(Tickets);
  const gens = [];
  const setData = d.view.setData.bind(d.view);
  d.view.setData = (data, cx) => {
    gens.push(data.gen);
    setData(data, cx);
  };
  d.key("r", { control: true }); // before the first load has got its list
  await d.until(
    () => d.view.data.phase === "ready" && /Speed up search/.test(d.text()),
    "the reloaded tickets",
  );
  assert.equal(d.view.data.gen, 2);
  assert.ok(gens.length > 0 && gens.every((g) => g === 2), `gens ${gens}`);
});

test("Tickets: while an action runs, Enter does nothing; once it's done, it works", async () => {
  const d = await ready();
  let finish;
  const held = new Promise((resolve) => (finish = resolve));
  d.view.model.act("Holding…", () => held);
  assert.equal(d.view.running, true);
  enterOn(d, "Add dark mode");
  assert.match(d.text(), /Holding…/);
  assert.deepEqual(ran(d, "space.new"), []);
  finish();
  await d.until(() => !d.view.running, "the action to finish");
  // Its worktree exists by now (an earlier test), so Enter opens its screen.
  d.submit();
  assert.equal(d.view.screen.name, "ticket");
});
