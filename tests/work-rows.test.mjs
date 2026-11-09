// What the Work sidebar shows (work-rows.js), without drawing it.
import assert from "node:assert/strict";
import { test } from "node:test";

const { workView, fit } = await import("../src/work-rows.js");

const repo = { path: "/ws/app", name: "app" };
const handle = (n) => ({
  key: `#${n}`,
  label: `#${n}`,
  tracker: { name: "GitHub" },
});
const wt = (n, more = {}) => ({
  path: `/ws/app/.worktrees/issue-${n}`,
  branch: `issue-${n}`,
  handle: handle(n),
  ...more,
});
const PR = {
  number: 7,
  state: "OPEN",
  draft: false,
  review: "REVIEW_REQUIRED",
  checks: "failed",
  checksPassed: 2,
  checksTotal: 5,
  mergeable: "MERGEABLE",
  url: "https://example.test/pr/7",
};
const STEPS = [
  { id: "fix-ci", label: "Fix CI", short: "Fix", kind: "agent" },
  { id: "finish", label: "Finish", short: "Finish", confirm: true },
];

const view = (over = {}) => {
  const { spaces = {}, prs = {}, ...rest } = over;
  return workView({
    groups: [
      {
        repo,
        hub: { path: "/ws/app", branch: "main", hub: true },
        worktrees: [wt(1), wt(2)],
      },
    ],
    folded: new Set(),
    width: 400,
    steps: new Map(),
    confirm: null,
    picked: null,
    now: 1_000_000,
    spaceOf: (w) => spaces[w.path] ?? null,
    stepsOf: (w) => (w.hub ? [] : STEPS),
    prOf: (w) => prs[w.path] ?? null,
    ticketOf: () => ({
      state: "found",
      value: { summary: "Do it", status: "In progress" },
    }),
    isTicket: (w) => Boolean(w.handle),
    costOf: () => null,
    ...rest,
  });
};
const one = wt(1).path;

test("fit: the width bands", () => {
  assert.deepEqual([null, 100, 200, 300, 400].map(fit), [
    "full",
    "rail",
    "glyph",
    "short",
    "full",
  ]);
});

test("the PR at each width; the tone stays whole while the head truncates", () => {
  const at = (width) => view({ width, prs: { [one]: PR } }).rows[1].pr;
  const full = at(400);
  assert.equal(full.shown, "full");
  assert.equal(full.head, "#7 in review");
  assert.equal(full.tail, "✗ 2/5");
  assert.equal(full.tone, "blocked");
  assert.equal(at(300).shown, "short");
  assert.equal(at(300).short, "#7 CI failed");
  assert.equal(at(200).shown, "glyph");
  assert.equal(at(200).glyph, "✗");
});

test("narrow: ticket status gives way and steps take short labels", () => {
  const wide = view().rows[1];
  assert.equal(wide.ticketStatus, "In progress");
  assert.equal(wide.steps[0].text, "Fix CI");
  const narrow = view({ width: 300 }).rows[1];
  assert.equal(narrow.ticketStatus, null);
  assert.equal(narrow.steps[0].text, "Fix");
});

test("the hub is the group's header, with no links or steps", () => {
  const v = view();
  const g = v.groups[0];
  assert.equal(g.hub, v.rows[0]);
  assert.equal(g.hub.title, "main");
  assert.equal(g.size, "3");
  assert.equal(g.count, "hub and 2 worktrees");
  assert.deepEqual(g.hub.links, []);
  assert.deepEqual(g.hub.steps, []);
  assert.equal(g.hub.tip.startsWith("app hub: main"), true);
});

test("folding keeps the hub, and it stays selectable", () => {
  const v = view({
    folded: new Set([repo.path]),
    picked: { path: "/ws/app", step: 0 },
  });
  assert.deepEqual(v.groups[0].worktrees, []);
  assert.equal(v.rows.length, 1);
  assert.equal(v.at, 0);
  assert.equal(v.rows[0].selected, true);
  // A picked row that's folded away falls back to the first row.
  const gone = view({
    folded: new Set([repo.path]),
    picked: { path: one, step: 1 },
  });
  assert.equal(gone.at, 0);
});

test("no space: the PR's glyph, or ○, with a tooltip", () => {
  const v = view({ prs: { [one]: PR } });
  assert.equal(v.rows[1].status.glyph, "✗");
  assert.equal(v.rows[1].status.tone, "blocked");
  assert.match(v.rows[1].status.tip, /no space open/);
  assert.equal(v.rows[2].status.glyph, "○");
  assert.equal(v.rows[2].status.tone, "dim");
});

test("a space's status: its glyph, or the spinner while working", () => {
  const v = view({
    spaces: {
      [one]: { id: "s1", status: "blocked" },
      [wt(2).path]: { id: "s2", status: "working" },
    },
  });
  assert.equal(v.rows[1].status.glyph, "!");
  assert.equal(v.rows[1].status.tip, null);
  assert.equal(v.rows[2].status.spin, true);
});

test("a failed step shows ✕ and its note, until the next step", () => {
  const steps = new Map([[one, { phase: "failed", text: "boom", at: 0 }]]);
  const r = view({ steps, spaces: { [one]: { id: "s", status: "idle" } } })
    .rows[1];
  assert.equal(r.status.glyph, "✕");
  assert.deepEqual(r.note, { text: "boom", tone: "blocked" });
});

test("a success note fades after a minute; a running step hides the steps", () => {
  const done = (at) =>
    view({ steps: new Map([[one, { phase: "done", text: "ok", at }]]) }).rows[1]
      .note;
  assert.equal(done(1_000_000 - 1000).text, "ok");
  assert.equal(done(0), null);
  const running = view({
    steps: new Map([[one, { phase: "running", text: "Fix CI…" }]]),
  });
  assert.deepEqual(running.rows[1].steps, []);
  assert.match(running.rows[1].tip, /Fix CI…$/);
});

test("selection: the focused space's row, picked steps clamp, confirming", () => {
  const spaces = { [wt(2).path]: { id: "s2", status: "idle", active: true } };
  assert.equal(view({ spaces }).at, 2);
  const v = view({ spaces, picked: { path: one, step: 9 } });
  assert.equal(v.at, 1);
  assert.equal(v.step, 1);
  assert.equal(v.rows[1].steps[1].chosen, true);
  const c = view({ confirm: { id: `${one}:finish`, byKey: true } }).rows[1];
  assert.equal(c.steps[1].confirming, true);
  assert.equal(c.steps[1].text, "Finish? Press again");
});

test("links: only what applies; a branch that isn't a ticket shows the branch", () => {
  const r = view({ prs: { [one]: PR } }).rows[1];
  assert.deepEqual(
    r.links.map((l) => l.id),
    ["pr", "ticket"],
  );
  assert.equal(r.title, "#1");
  assert.equal(r.num, "1");
  const plain = view({ isTicket: () => false, ticketOf: () => null }).rows[1];
  assert.deepEqual(plain.links, []);
  assert.equal(plain.title, "issue-1");
  assert.equal(plain.sub, "");
});
