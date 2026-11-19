// Edge cases of the shared modules, through their exports, against fake
// programs: lib (pool, openUrl, moveKey), sending a step to the agent,
// opening spaces, and the trackers' error and not-found paths.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { live, runs } from "herdr";
import { C, useConfig } from "../src/config.js";
import { runStep } from "../src/flow.js";
import { moveKey, openUrl, pool } from "../src/lib.js";
import { openSpaces } from "../src/start.js";
import * as github from "../src/tracker-github.js";
import * as jira from "../src/tracker-jira.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sheltie-branches-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// A fake program `name` in `dir`: logs its arguments to name.log, then runs
// the shell snippet `reply` sets (its stdout, stderr and exit code).
const log = (name) => path.join(dir, `${name}.log`);
const logged = (name) =>
  fs.existsSync(log(name))
    ? fs.readFileSync(log(name), "utf8").trim().split("\n")
    : [];
function fake(name, reply = "exit 0") {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh\necho "$*" >> '${log(name)}'\n. '${file}.reply'\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(`${file}.reply`, reply);
  fs.rmSync(log(name), { force: true });
  return file;
}
const reply = (name, snippet) =>
  fs.writeFileSync(path.join(dir, `${name}.reply`), snippet);

afterEach(() => {
  Object.assign(live, { panes: [], spaces: [], agents: [], terminals: [] });
  runs.length = 0;
  useConfig({});
});

const rejects = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.message;
  }
  assert.fail("expected it to throw");
};

// --- lib ----------------------------------------------------------------------

test("pool: runs at most `size` at once, keeps order, a failed task gives null", async () => {
  let running = 0;
  let most = 0;
  const task = (v, fail) => async () => {
    running++;
    most = Math.max(most, running);
    await new Promise((go) => setTimeout(go, 5));
    running--;
    if (fail) throw new Error("no");
    return v;
  };
  const out = await pool(
    [task(1), task(2, true), task(3), task(4), task(5)],
    2,
  );
  assert.deepEqual(out, [1, null, 3, 4, 5]);
  assert.equal(most, 2);
  assert.deepEqual(await pool([]), []);
});

test("openUrl: xdg-open when it works, else open; neither is fine", async () => {
  const was = process.env.PATH;
  process.env.PATH = dir;
  try {
    fake("xdg-open");
    fake("open");
    await openUrl("https://a");
    assert.deepEqual(logged("xdg-open"), ["https://a"]);
    assert.deepEqual(logged("open"), []);

    reply("xdg-open", "exit 3");
    await openUrl("https://b");
    assert.deepEqual(logged("open"), ["https://b"]);

    fs.rmSync(path.join(dir, "xdg-open")); // not Linux
    await openUrl("https://c");
    assert.deepEqual(logged("open"), ["https://b", "https://c"]);

    fs.rmSync(path.join(dir, "open"));
    await openUrl("https://d"); // nothing to open it with: no throw
  } finally {
    process.env.PATH = was;
  }
});

test("moveKey: arrows and Ctrl+N/P wrap, Esc closes, other keys aren't ours", () => {
  const key = (k, control = false) => ({ key: k, modifiers: { control } });
  const view = { at: 0 };
  let closed = 0;
  const close = () => closed++;
  assert.equal(moveKey(key("down"), view, 3, close), true);
  assert.equal(view.at, 1);
  moveKey(key("n", true), view, 3, close);
  moveKey(key("n", true), view, 3, close);
  assert.equal(view.at, 0);
  moveKey(key("up"), view, 3, close);
  assert.equal(view.at, 2);
  moveKey(key("p", true), view, 3, close);
  assert.equal(view.at, 1);
  assert.equal(moveKey(key("n"), view, 3, close), false); // no Ctrl
  assert.equal(moveKey(key("x"), view, 3, close), false);
  assert.equal(view.at, 1);
  // No rows: the selection stays at 0.
  const empty = { at: 0 };
  moveKey(key("down"), empty, 0, close);
  moveKey(key("up"), empty, 0, close);
  assert.equal(empty.at, 0);
  assert.equal(moveKey(key("escape"), view, 3, close), true);
  assert.equal(closed, 1);
});

// --- Sending a step to the agent --------------------------------------------

const w = { path: "/w", branch: "b", repo: {}, handle: { label: "#7" } };
const pr = { number: 7, state: "OPEN" };

test("an agent step the agent can't take: the send's error, no space selected", async () => {
  useConfig({
    programs: {
      ...C.programs,
      hc: fake(
        "hc",
        'case "$1" in send) echo "no such terminal" >&2; exit 1;; esac',
      ),
    },
  });
  Object.assign(live, {
    spaces: [{ id: "s1", folder: "/w", tabs: [] }],
    agents: [{ space: "s1", address: "t7" }],
  });
  assert.equal(
    await rejects(runStep("fix-ci", w, pr)),
    "couldn't reach the agent: no such terminal",
  );
  assert.deepEqual(runs, []);
});

test("an agent step sent: selects the agent's space", async () => {
  useConfig({ programs: { ...C.programs, hc: fake("hc") } });
  Object.assign(live, {
    spaces: [{ id: "s1", folder: "/w", tabs: [] }],
    agents: [{ space: "s1", address: "t7" }],
  });
  await runStep("fix-ci", w, pr);
  assert.deepEqual(runs, [["space.select", { id: "s1" }]]);
});

test("an agent step with no agent: a new tab in its space, else a new space", async () => {
  live.spaces = [{ id: "s1", folder: "/w", tabs: [] }];
  assert.equal(await runStep("fix-ci", w, pr), "sent /fix-ci");
  assert.deepEqual(runs, [
    [
      "tab.new",
      { space: "s1", folder: "/w", argv: C.agent.argv, task: "/fix-ci" },
    ],
  ]);

  runs.length = 0;
  live.spaces = [];
  await runStep("fix-ci", w, pr);
  await runStep("fix-ci", { ...w, path: "/x/y", handle: null }, pr);
  assert.deepEqual(
    runs.map(([m, p]) => [m, p.name, p.folder]),
    [
      ["space.new", "#7", "/w"],
      ["space.new", "y", "/x/y"],
    ],
  );
});

// --- Opening spaces -----------------------------------------------------------

test("openSpaces: selects an open space, else starts one (with its task, if any)", () => {
  live.spaces = [{ id: "s1", folder: "/a", tabs: [] }];
  openSpaces([
    { name: "A", folder: "/a", task: "do a" },
    { name: "B", folder: "/b", task: "do b" },
    { name: "C", folder: "/c", task: null },
  ]);
  assert.deepEqual(runs, [
    ["space.select", { id: "s1" }],
    [
      "space.new",
      { name: "B", folder: "/b", argv: C.agent.argv, task: "do b" },
    ],
    ["space.new", { name: "C", folder: "/c", argv: C.agent.argv }],
  ]);
});

// --- The GitHub tracker -------------------------------------------------------

const gh = (settings = {}) => {
  useConfig({ programs: { ...C.programs, gh: fake("gh") } });
  return github.create({ ...C, github: { ...C.github, ...settings } });
};

test("github: keys it can't parse are labelled as given and have no issue", async () => {
  const t = gh();
  assert.equal(t.labelOf("nonsense"), "nonsense");
  assert.equal(await t.view("nonsense"), null);
  assert.equal(await t.url("nonsense"), null);
  assert.equal(t.viewCommand("nonsense"), "nonsense");
  assert.deepEqual(logged("gh"), []);
  assert.equal(gh({ repos: ["a/b"] }).labelOf("a/b#3"), "#3");
  assert.equal(gh({ repos: ["a/b", "a/c"] }).labelOf("a/b#3"), "b#3");
});

test("github list: the search, assignee and repos it's set to", async () => {
  const t = gh({ search: "label:bug", assignee: "", repos: ["a/b"] });
  reply("gh", `echo '[{"number":1,"repository":{"nameWithOwner":"A/B"}}]'`);
  const [one] = await t.list();
  assert.deepEqual(
    {
      key: one.key,
      summary: one.summary,
      status: one.status,
      labels: one.labels,
    },
    { key: "a/b#1", summary: "", status: "Closed", labels: [] },
  );
  assert.match(
    logged("gh")[0],
    /^search issues label:bug --state open --repo a\/b /,
  );
});

test("github view: not found is null, other failures throw", async () => {
  const t = gh();
  reply("gh", 'echo "GraphQL: Could not resolve to an Issue" >&2; exit 1');
  assert.equal(await t.view("a/b#9"), null);
  reply("gh", 'echo "connection refused" >&2; exit 1');
  assert.equal(await rejects(t.view("a/b#9")), "connection refused");
  reply("gh", "exit 1");
  assert.equal(await rejects(t.view("a/b#9")), "gh issue view a/b#9 failed");
});

test("github move: only done, only when set to, only an open issue", async () => {
  reply("gh", "exit 0");
  assert.equal(await gh().move("a/b#1", "start"), null);
  assert.equal(await gh({ closeOnFinish: false }).move("a/b#1", "done"), null);
  const t = gh();
  assert.equal(await t.move("nonsense", "done"), null);
  reply("gh", `echo '{"number":1,"state":"CLOSED"}'`);
  assert.equal(await t.move("a/b#1", "done"), null);
  assert.equal(logged("gh").length, 1); // looked, didn't close
  reply("gh", `echo '{"number":1,"state":"OPEN"}'`);
  assert.equal(await t.move("a/b#1", "done"), "b#1 closed");
  assert.match(logged("gh").at(-1), /^issue close 1 --repo a\/b/);
});

test("github linkedPRs: a failed lookup or a bad key gives no PRs", async () => {
  const t = gh();
  reply(
    "gh",
    `case "$3" in
  1) echo '{"closedByPullRequestsReferences":[{"url":"https://github.com/a/b/pull/4"},{"url":"elsewhere"},{}]}';;
  2) echo '{}';;
  *) echo "boom" >&2; exit 1;;
esac`,
  );
  const out = await t.linkedPRs(["a/b#1", "a/b#2", "a/b#3", "nonsense"]);
  assert.deepEqual(Object.fromEntries(out), {
    "a/b#1": [{ slug: "a/b", number: 4 }],
    "a/b#2": [],
    "a/b#3": [],
    nonsense: [],
  });
  assert.deepEqual(t.suggest({ repo: null }), []);
});

// --- The Jira tracker ---------------------------------------------------------

const jr = (settings = {}, more = {}) => {
  useConfig({
    programs: { ...C.programs, jira: fake("jira"), gh: fake("gh") },
  });
  return jira.create({ ...C, jira: { ...C.jira, ...settings }, ...more });
};

test("jira list: no output is no tickets; missing fields are empty", async () => {
  const t = jr();
  assert.deepEqual(await t.list(), []);
  reply("jira", `echo '[{"key":"WEB-1"}]'`);
  const [one] = await t.list();
  assert.deepEqual(
    [one.summary, one.status, one.components, one.labels, one.project],
    ["", "", [], [], "WEB"],
  );
});

test("jira view: an error on stdout counts, else a default message", async () => {
  const t = jr();
  reply("jira", 'echo "issue does not exist"; exit 1');
  assert.equal(await t.view("WEB-1"), null);
  reply("jira", 'echo "401 unauthorized"; exit 1');
  assert.equal(await rejects(t.view("WEB-1")), "401 unauthorized");
  reply("jira", "exit 1");
  assert.equal(await rejects(t.view("WEB-1")), "jira issue view WEB-1 failed");
});

test("jira move: the resolution on done; failures name the transition", async () => {
  const t = jr({ transitions: { done: "Resolved" }, resolution: "Fixed" });
  assert.equal(await t.move("WEB-1", "done"), "WEB-1 → Resolved");
  assert.deepEqual(logged("jira"), [
    "issue move WEB-1 Resolved --resolution Fixed",
  ]);
  assert.equal(await t.move("WEB-1", "done", "Resolved"), null);
  reply("jira", 'echo "not allowed"; exit 1');
  assert.equal(
    await rejects(t.move("WEB-1", "done")),
    "WEB-1 → Resolved: not allowed",
  );
  reply("jira", "exit 1");
  assert.equal(
    await rejects(t.move("WEB-1", "done")),
    "WEB-1 → Resolved: jira issue move failed",
  );
});

test("jira url: what jira open prints, null when it fails, prints nothing or isn't there", async () => {
  const t = jr();
  reply("jira", 'echo "https://jira/WEB-1"');
  assert.equal(await t.url("WEB-1"), "https://jira/WEB-1");
  reply("jira", "exit 0");
  assert.equal(await t.url("WEB-1"), null);
  reply("jira", "exit 1");
  assert.equal(await t.url("WEB-1"), null);
  useConfig({ programs: { ...C.programs, jira: path.join(dir, "missing") } });
  assert.equal(await t.url("WEB-1"), null);
});

test("jira linkedPRs: owners from repos and repo rules; none to ask, no search", async () => {
  const none = jr({}, { githubOwners: [], repoRules: [] });
  assert.deepEqual(Object.fromEntries(await none.linkedPRs(["WEB-1"], [])), {
    "WEB-1": [],
  });
  assert.deepEqual(
    Object.fromEntries(await none.linkedPRs([], [{ slug: "o/r" }])),
    {},
  );
  assert.deepEqual(logged("gh"), []);

  const t = jr(
    {},
    {
      githubOwners: [],
      repoRules: [{ repo: "rules/app" }, { repo: "~/local" }, {}],
    },
  );
  reply(
    "gh",
    `echo '[{"number":5,"title":"WEB-1: fix","repository":{"nameWithOwner":"o/r"}},{"number":6,"title":"other"}]'`,
  );
  const out = await t.linkedPRs(["WEB-1", "WEB-2"], [{ slug: "o/r" }, {}]);
  assert.deepEqual(Object.fromEntries(out), {
    "WEB-1": [{ slug: "o/r", number: 5 }],
    "WEB-2": [],
  });
  assert.match(logged("gh")[0], /--owner o --owner rules$/);
});
