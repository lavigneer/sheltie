// The Work sidebar (src/work/main.js, loaded as built in mods/work/) through the herdr stub: real git repos,
// a fake gh, keys through nextCommand; asserts on what it renders and the
// run(...) calls it makes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gitRepo, prNode, sandbox } from "./fake-tools.mjs";

const box = sandbox({ settings: { github: { repos: ["me/app"] } } });
const app = gitRepo(box.root, "app", "me/app", ["issue-1", "issue-2"]);
box.setState({
  issues: { 1: { title: "Fix the login" }, 2: { title: "Add dark mode" } },
  prs: { "issue-2": prNode(12, "issue-2") },
});

const { mount } = await import("./mod-driver.mjs");
const { default: Work } = await import("../mods/work/main.js");

test("Work: shows a row per worktree, with its ticket", async () => {
  const d = mount(Work);
  await d.until(
    () => /Fix the login/.test(d.text()) && /Add dark mode/.test(d.text()),
    "both tickets",
  );
  assert.match(d.text(), /#1/);
  assert.match(d.text(), /#2/);
});

const { live } = await import("./herdr-stub.mjs");
const { find } = await import("./mod-driver.mjs");
const wt1 = app.worktree("issue-1");
const wt2 = app.worktree("issue-2");

// The rows once both tickets show.
async function ready() {
  const d = mount(Work);
  await d.until(
    () => /Fix the login/.test(d.text()) && /#12/.test(d.text()),
    "both rows and the PR",
  );
  return d;
}
// Which row is selected (outlined in the accent colour): the hub's path or
// a worktree's.
const selected = (d) => {
  const tree = d.render();
  if (find(tree, `work-repo-${app.path}`)?.style.border_color === "accent")
    return app.path;
  return [wt1, wt2].find(
    (p) => find(tree, `work-${p}`)?.style.border_color === "accent",
  );
};
const ran = (d, name) => d.calls.run.filter((c) => c.name === name);

test("Work: a row with no PR offers Draft PR; one with a draft PR doesn't", async () => {
  const d = await ready();
  // wt1 offers Draft PR once its PR lookup says it has none.
  await d.until(
    () => find(d.render(), `work-step-${wt1}-draft-pr`),
    "wt1's Draft PR",
  );
  const tree = d.render();
  assert.equal(find(tree, `work-step-${wt2}-draft-pr`), null);
  assert.match(d.text(), /#12/);
});

test("Work: clicking a row with no space opens one there, with the agent", async () => {
  const d = await ready();
  d.click(`work-${wt1}`);
  assert.deepEqual(ran(d, "space.new"), [
    {
      name: "space.new",
      args: { name: "#1", folder: wt1, argv: ["claude"] },
    },
  ]);
});

test("Work: the focused space's row is selected; clicking a row with a space selects it", async (t) => {
  live.spaces = [{ id: "s2", folder: wt2, tabs: [], active: true }];
  t.after(() => {
    live.spaces = [];
  });
  const d = await ready();
  assert.equal(selected(d), wt2);
  d.click(`work-${wt2}`);
  assert.deepEqual(ran(d, "space.select"), [
    { name: "space.select", args: { id: "s2" } },
  ]);
  assert.deepEqual(ran(d, "space.new"), []);
});

test("Work: work.next / work.prev move the selection from the hub; work.open opens the selected row", async () => {
  const d = await ready();
  assert.equal(selected(d), app.path);
  await d.press("next");
  assert.equal(selected(d), wt1);
  await d.press("next");
  assert.equal(selected(d), wt2);
  await d.press("open");
  assert.deepEqual(
    ran(d, "space.new").map((c) => c.args.folder),
    [wt2],
  );
  await d.press("prev");
  assert.equal(selected(d), wt1);
});

test("Work: work.step runs the selected row's step: Draft PR starts its agent with the task", async () => {
  const d = await ready();
  await d.press("next");
  await d.press("step");
  const started = await d.until(() => ran(d, "space.new")[0], "space.new");
  assert.deepEqual(started.args, {
    name: "#1",
    folder: wt1,
    argv: ["claude"],
    task: "/draft-pr",
  });
  await d.until(() => /sent \/draft-pr/.test(d.text()), "the step's note");
});

test("Work: clicking a step button runs it like work.step", async () => {
  const d = await ready();
  d.click(`work-step-${wt1}-draft-pr`);
  await d.until(() => ran(d, "space.new").length === 1, "space.new");
  assert.equal(ran(d, "space.new")[0].args.task, "/draft-pr");
});

test("Work: work.open-ticket / work.open-pr open the selected row's links; no PR says so", async () => {
  const d = await ready();
  const before = box.opened().length;
  await d.press("next");
  await d.press("open-ticket");
  await d.until(() => box.opened().length > before, "the ticket opened");
  assert.equal(box.opened().at(-1), "https://github.com/me/app/issues/1");
  await d.press("open-pr");
  assert.deepEqual(
    d.calls.notify.map((n) => n.title),
    ["#1: no pull request"],
  );
  await d.press("next");
  await d.press("open-pr");
  await d.until(() => box.opened().length > before + 1, "the PR opened");
  assert.equal(box.opened().at(-1), "https://github.com/me/app/pull/12");
});

test("Work: work.group switches to grouping by PR stage, and back", async () => {
  const d = await ready();
  assert.ok(find(d.render(), `work-repo-${app.path}`));
  await d.press("group");
  await d.until(
    () => !find(d.render(), `work-repo-${app.path}`),
    "grouping by stage",
  );
  await d.press("group");
  assert.ok(find(d.render(), `work-repo-${app.path}`));
});

test("Work: Merge asks for a second work.step before merging", async (t) => {
  const was = JSON.parse(
    (await import("node:fs")).readFileSync(`${box.dir}/state.json`, "utf8"),
  );
  t.after(() => box.setState(was));
  box.setState({
    ...was,
    prs: {
      "issue-2": prNode(12, "issue-2", {
        isDraft: false,
        reviewDecision: "APPROVED",
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: { nodes: [{ conclusion: "SUCCESS" }] },
                },
              },
            },
          ],
        },
      }),
    },
  });
  const d = await ready();
  const merges = () =>
    box.ghCalls().filter((a) => a[0] === "pr" && a[1] === "merge");
  await d.press("next");
  await d.press("next");
  assert.ok(find(d.render(), `work-step-${wt2}-merge`));
  await d.press("step");
  assert.equal(
    find(d.render(), `work-step-${wt2}-merge`).style.border_color,
    "blocked",
  );
  assert.deepEqual(merges(), []);
  await d.press("step");
  await d.until(() => merges().length === 1, "gh pr merge");
  assert.deepEqual(merges()[0].slice(0, 2), ["pr", "merge"]);
  assert.ok(merges()[0].includes("12"));
});
