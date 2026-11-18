// The Work sidebar's view reuse (view-key.js): unchanged inputs skip workView;
// a change to any input makes a fresh view.
import assert from "node:assert/strict";
import { test } from "node:test";

const { viewKey, ViewMemo } = await import("../src/view-key.js");

const NOW = 1_000_000;

function inputs() {
  return {
    versions: [1, 2, 3, 4],
    live: {
      local: [
        {
          id: "s1",
          folder: "/w/a",
          status: "idle",
          active: true,
          tabs: [{ id: "t1" }],
        },
      ],
      panes: [
        { tab: "t1", cwd: "/w/a", terminal: "x1", program: { key: "claude" } },
      ],
      terminals: [{ address: "x1", labels: { agent: "claude" } }],
      agents: [{ space: "s1", address: "x1" }],
    },
    nav: { folded: new Set(), expanded: new Set(), pick: null },
    confirm: null,
    steps: new Map([["/w/a", { phase: "done", text: "ok", at: NOW - 1000 }]]),
    starting: new Map([["/w/a", NOW - 1000]]),
    now: NOW,
    noteMs: 60_000,
    startMs: 30_000,
    rest: ["repo", 400, 0, "claude", "[]"],
  };
}

test("unchanged inputs reuse the view without calling workView", () => {
  const memo = new ViewMemo();
  let calls = 0;
  const compute = () => ({ rows: [], n: ++calls });
  const a = memo.get(viewKey(inputs()), compute);
  const b = memo.get(viewKey(inputs()), compute);
  const c = memo.get(viewKey({ ...inputs(), now: NOW + 500 }), compute);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(a, c);
  memo.get(viewKey({ ...inputs(), versions: [2, 2, 3, 4] }), compute);
  assert.equal(calls, 2);
});

const changes = {
  "store version": (x) => {
    x.versions[0]++;
  },
  "tickets version": (x) => {
    x.versions[1]++;
  },
  "linked version": (x) => {
    x.versions[2]++;
  },
  "prs version": (x) => {
    x.versions[3]++;
  },
  "space status": (x) => {
    x.live.local[0].status = "working";
  },
  "space folder": (x) => {
    x.live.local[0].folder = "/w/b";
  },
  "space active": (x) => {
    x.live.local[0].active = false;
  },
  "space tabs": (x) => {
    x.live.local[0].tabs.push({ id: "t2" });
  },
  "space added": (x) => {
    x.live.local.push({ id: "s2", tabs: [] });
  },
  "pane cwd": (x) => {
    x.live.panes[0].cwd = "/w/c";
  },
  "pane terminal": (x) => {
    x.live.panes[0].terminal = "x2";
  },
  "pane program": (x) => {
    x.live.panes[0].program = { key: "zsh" };
  },
  "terminal pr label": (x) => {
    x.live.terminals[0].labels.pr = "ready";
  },
  "terminal agent label": (x) => {
    x.live.terminals[0].labels.agent = null;
  },
  "agent space": (x) => {
    x.live.agents[0].space = "s2";
  },
  fold: (x) => {
    x.nav.folded.add("/r");
  },
  expand: (x) => {
    x.nav.expanded.add("/r");
  },
  pick: (x) => {
    x.nav.pick = { path: "/w/a", step: 1, active: "s1" };
  },
  confirm: (x) => {
    x.confirm = { id: "/w/a:finish" };
  },
  "step phase": (x) => {
    x.steps.get("/w/a").phase = "failed";
  },
  "step stale mark cleared": (x) => {
    x.steps.set("/w/a", {
      phase: "done",
      text: "ok",
      at: NOW - 1000,
      staleAt: 5,
    });
  },
  "note fades": (x) => {
    x.now = NOW + 60_000;
  },
  "starting ends": (x) => {
    x.now = NOW + 29_500;
  },
  "starting added": (x) => {
    x.starting.set("/w/b", NOW);
  },
  "width, grouping, costs": (x) => {
    x.rest[1] = 300;
  },
};

for (const [name, change] of Object.entries(changes))
  test(`a fresh view when ${name} changes`, () => {
    const memo = new ViewMemo();
    let calls = 0;
    const compute = () => ++calls;
    memo.get(viewKey(inputs()), compute);
    const x = inputs();
    change(x);
    assert.equal(memo.get(viewKey(x), compute), 2);
  });
