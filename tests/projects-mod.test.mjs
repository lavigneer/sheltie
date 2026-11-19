// The Projects overlay (src/projects/main.js, loaded as built in
// mods/projects/) through the herdr stub: real git repos under the root;
// types into its input, sends it keys, and asserts on what it renders and
// the run(...)/closeOverlay(...) calls it makes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gitRepo, sandbox } from "./fake-tools.mjs";

const box = sandbox();
const app = gitRepo(box.root, "app", "me/app", ["issue-1"]);
const web = gitRepo(box.root, "web", "me/web");
const tools = gitRepo(box.root, "tools", "me/tools");

const { mount, findAll } = await import("./mod-driver.mjs");
const { live } = await import("./herdr-stub.mjs");
const { default: Projects } = await import("../mods/projects/main.js");

const ran = (d, name) => d.calls.run.filter((c) => c.name === name);
const shown = (d) => findAll(d.render(), "pj-").map((r) => r.id.slice(3));
// The highlighted row (drawn with the hover colour).
const selected = (d) =>
  findAll(d.render(), "pj-")
    .find((r) => r.style.bg === "hover")
    ?.id.slice(3);
async function ready() {
  const d = mount(Projects);
  await d.until(() => shown(d).length === 3, "the repos");
  return d;
}

test("Projects: lists the repos under the roots by name, not their worktrees", async () => {
  const d = await ready();
  assert.deepEqual(shown(d), [app.path, tools.path, web.path]);
  assert.equal(selected(d), app.path);
  assert.ok(d.input().focused);
});

test("Projects: typing filters the repos, best match first; nothing matching says so", async () => {
  const d = await ready();
  // (The full path is matched too, and the sandbox's temp path is random:
  // only the best match is certain.)
  d.input().type("web");
  assert.equal(shown(d)[0], web.path);
  assert.equal(selected(d), web.path);
  d.input().type("web!");
  assert.deepEqual(shown(d), []);
  assert.match(d.text(), /No matching project/);
});

test("Projects: Enter opens a new space on the selected repo and closes the overlay", async () => {
  const d = await ready();
  d.input().type("tools");
  d.input().submit();
  assert.deepEqual(ran(d, "space.new"), [
    { name: "space.new", args: { name: "tools", folder: tools.path } },
  ]);
  assert.deepEqual(d.calls.closeOverlay, ["overlay-1"]);
});

test("Projects: Down / Ctrl+P move the selection, wrapping; clicking a row opens it", async () => {
  const d = await ready();
  d.key("projects", "down");
  assert.equal(selected(d), tools.path);
  d.key("projects", "p", { control: true });
  d.key("projects", "p", { control: true });
  assert.equal(selected(d), web.path);
  d.input().submit();
  assert.deepEqual(
    ran(d, "space.new").map((c) => c.args.folder),
    [web.path],
  );
  d.click(`pj-${app.path}`);
  assert.deepEqual(
    ran(d, "space.new").map((c) => c.args.folder),
    [web.path, app.path],
  );
});

test("Projects: a repo with a space open goes to it; a worktree's space doesn't count", async (t) => {
  live.spaces = [
    { id: "s-wt", folder: app.worktree("issue-1"), tabs: [] },
    { id: "s-web", folder: web.path, tabs: [] },
  ];
  t.after(() => {
    live.spaces = [];
  });
  const d = await ready();
  // Among equal matches, a repo with an open space comes first.
  assert.deepEqual(shown(d), [web.path, app.path, tools.path]);
  d.input().submit();
  assert.deepEqual(ran(d, "space.select"), [
    { name: "space.select", args: { id: "s-web" } },
  ]);
  // app's only space is its worktree's: Enter on app opens a new one.
  d.input().type("app");
  d.input().submit();
  assert.deepEqual(
    ran(d, "space.new").map((c) => c.args.folder),
    [app.path],
  );
});

test("Projects: Esc closes the overlay without opening anything", async () => {
  const d = await ready();
  d.key("projects", "escape");
  assert.deepEqual(d.calls.closeOverlay, ["overlay-1"]);
  assert.deepEqual(d.calls.run, []);
});
