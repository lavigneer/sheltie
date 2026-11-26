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
  assert.equal(at(300).head, "#7 CI failed");
  assert.equal(at(300).tail, "");
  assert.equal(at(200).shown, "glyph");
  assert.equal(at(200).head, "✗");
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

test("steps: only the first, the most pressing, is primary", () => {
  const steps = view().rows[1].steps;
  assert.ok(steps.length > 1);
  assert.deepEqual(
    steps.map((s) => s.primary),
    steps.map((_s, i) => i === 0),
  );
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

test("by stage: a group per stage in the flow's order, each row naming its repo", () => {
  const two = wt(2).path;
  const v = view({
    by: "stage",
    prs: {
      [one]: { ...PR, state: "MERGED" },
      [two]: { ...PR, draft: true },
    },
  });
  assert.equal(v.by, "stage");
  assert.deepEqual(
    v.groups.map((g) => [g.key, g.name, g.size, g.hub]),
    [
      ["stage:draft", "Draft", "1", null],
      ["stage:merged", "Merged", "1", null],
    ],
  );
  assert.deepEqual(
    v.rows.map((r) => r.w.path),
    [two, one],
  );
  assert.equal(v.rows[0].sub, "app · Do it");
  assert.equal(v.rows[0].selected, true);
});

test("by stage: hubs with a space lead in their own group; folding hides rows", () => {
  const hub = "/ws/app";
  const v = view({
    by: "stage",
    spaces: { [hub]: { id: "s1", status: "idle" } },
    folded: new Set(["stage:no-pr"]),
  });
  assert.deepEqual(
    v.groups.map((g) => [g.name, g.open, g.worktrees.length]),
    [
      ["Hubs", true, 1],
      ["No PR", false, 0],
    ],
  );
  assert.equal(v.rows.length, 1);
  assert.equal(v.rows[0].title, "app");
  assert.equal(v.rows[0].sub, "main");
});

test("by repo (the default): groups keyed by the repo's path, rows unprefixed", () => {
  const v = view();
  assert.equal(v.by, "repo");
  assert.equal(v.groups[0].key, "/ws/app");
  assert.equal(v.rows[1].sub, "Do it");
});

test("cap: a long repo group shows its most recently changed, plus a focused one", () => {
  const ws = [1, 2, 3, 4, 5].map((n) => wt(n, { at: n * 10 }));
  const groups = [
    {
      repo,
      hub: { path: "/ws/app", branch: "main", hub: true },
      worktrees: ws,
    },
  ];
  const paths = (v) => v.groups[0].worktrees.map((r) => r.w.branch);
  // The two most recent (5, 4), in their order, and the focused one (1).
  const v = view({
    groups,
    cap: 2,
    spaces: { [ws[0].path]: { id: "s1", active: true } },
  });
  assert.deepEqual(paths(v), ["issue-1", "issue-4", "issue-5"]);
  assert.equal(v.groups[0].more, 2);
  assert.equal(v.groups[0].fewer, false);
  // Keys move only through what's shown: the hub and those three.
  assert.equal(v.rows.length, 4);
  // Expanded: all of them, offering "Show fewer".
  const all = view({ groups, cap: 2, expanded: new Set([repo.path]) });
  assert.equal(all.groups[0].worktrees.length, 5);
  assert.equal(all.groups[0].more, 0);
  assert.equal(all.groups[0].fewer, true);
  // No cap, or a group within it: all, and nothing to offer.
  for (const cap of [0, 5]) {
    const g = view({ groups, cap }).groups[0];
    assert.equal(g.worktrees.length, 5);
    assert.equal(g.more + Number(g.fewer), 0);
  }
  // Folded: no "+k more" either.
  const f = view({ groups, cap: 2, folded: new Set([repo.path]) }).groups[0];
  assert.equal(f.more, 0);
});
