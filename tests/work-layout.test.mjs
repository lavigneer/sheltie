// The Work sidebar's layout (the builders in work-rows.js), drawn without a
// View: each builder gets rows from workView and a fake `ui`, and the test
// reads the element tree it returns (the gpui-stub records ids, text, styles
// and handlers) and calls its handlers.
import assert from "node:assert/strict";
import { test } from "node:test";

const { bodyEl, groupEl, headerEl, messageEl, rowEl, subRowEl, workView } =
  await import("../src/work-rows.js");

const repo = { path: "/ws/app", name: "app" };
const handle = (n) => ({
  key: `#${n}`,
  label: `#${n}`,
  tracker: { name: "GitHub" },
});
const wt = (n) => ({
  path: `/ws/app/.worktrees/issue-${n}`,
  branch: `issue-${n}`,
  handle: handle(n),
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

// workView over one repo (a hub and `n` worktrees), with `over` in the input.
const view = (over = {}) => {
  const { prs = {}, stacks = {}, ...rest } = over;
  return workView({
    groups: [
      {
        repo,
        hub: { path: "/ws/app", branch: "main", hub: true },
        worktrees: [wt(1), wt(2), wt(3)],
      },
    ],
    folded: new Set(),
    width: 400,
    steps: new Map(),
    confirm: null,
    armed: () => false,
    picked: null,
    now: 1_000_000,
    spaceOf: () => null,
    stepsOf: (w) => (w.hub ? [] : STEPS),
    prOf: (w) => prs[w.path] ?? null,
    stackOf: (w) => stacks[w.path] ?? [],
    ticketOf: () => ({
      state: "found",
      value: { summary: "Do it", status: "In progress" },
    }),
    isTicket: (w) => Boolean(w.handle),
    costOf: () => null,
    ...rest,
  });
};

// A fake `ui`: the theme, the state, and actions that record what they got.
const t = {
  foreground: "fg",
  dim: "dim",
  muted: "muted",
  accent: "accent",
  background: "bg",
  hover: "hov",
  blocked: "red",
  done: "green",
  popover: "pop",
};
const calls = [];
const ui = (over = {}) => ({
  t,
  rail: false,
  hovered: null,
  linksOpen: null,
  open: (w) => calls.push(["open", w.path]),
  openStacked: (p) => calls.push(["stacked", p.key]),
  step: (_cx, w, s) => calls.push(["step", w.path, s.id]),
  follow: (_cx, w, id) => calls.push(["follow", w.path, id]),
  hoverRow: (_cx, w, hovered) => calls.push(["hover", w.path, hovered]),
  openLinks: (_cx, w, open) => calls.push(["openLinks", w.path, open]),
  closeLinks: () => calls.push(["closeLinks"]),
  expand: (_cx, key) => calls.push(["expand", key]),
  fold: (_cx, g) => calls.push(["fold", g.key]),
  toggleGroupBy: () => calls.push(["group"]),
  refresh: () => calls.push(["refresh"]),
  newWork: () => calls.push(["new"]),
  ...over,
});

// A fake click context: stop_propagation records that it was called.
const cx = () => ({
  stopped: false,
  notified: 0,
  stop_propagation() {
    this.stopped = true;
  },
  notify() {
    this.notified++;
  },
});

// The first element under `node` with this id (its recorded data), or null.
const byId = (node, id) => {
  if (typeof node !== "object" || node === null) return null;
  if (node.$.id === id) return node.$;
  for (const c of node.$.children) {
    const hit = byId(c, id);
    if (hit) return hit;
  }
  return null;
};
// Every element under `node` with an id starting with `prefix`.
const idsUnder = (node, prefix, out = []) => {
  if (typeof node !== "object" || node === null) return out;
  if (typeof node.$.id === "string" && node.$.id.startsWith(prefix))
    out.push(node.$.id);
  for (const c of node.$.children) idsUnder(c, prefix, out);
  return out;
};
// The text under `node`, in order.
const textOf = (node) =>
  typeof node === "string"
    ? node
    : node.$.children.map((c) => textOf(c)).join("");

test("header: a rail has only +; the full header has group, refresh and +", () => {
  const rail = headerEl(ui({ rail: true }), "repo", false);
  assert.deepEqual(idsUnder(rail, "work-"), ["work-new"]);
  assert.equal(textOf(rail), "+");

  const full = headerEl(ui(), "repo", false);
  assert.deepEqual(idsUnder(full, "work-"), [
    "work-group",
    "work-refresh",
    "work-new",
  ]);
  assert.equal(byId(full, "work-group").style.tooltip, "Group by stage");
  assert.equal(byId(full, "work-refresh").style.tooltip, "Refresh now");

  const c = cx();
  byId(full, "work-group").on.click({}, c);
  byId(full, "work-refresh").on.click({}, c);
  assert.deepEqual(calls.splice(0), [["group"], ["refresh"]]);
  assert.equal(c.stopped, true, "a header click doesn't reach the list");
});

test("header: by stage names the other grouping; refreshing says so", () => {
  const h = headerEl(ui(), "stage", true);
  assert.equal(byId(h, "work-group").style.tooltip, "Group by repo");
  assert.equal(byId(h, "work-refresh").style.tooltip, "Refreshing…");
  assert.equal(byId(h, "work-refresh").children.length, 1);
});

test("messages: loading, empty, and a problem on a rail", () => {
  assert.equal(
    textOf(bodyEl(ui(), { groups: [] }, true)),
    "Loading worktrees…",
  );
  const empty = bodyEl(ui(), { groups: [] }, false);
  assert.equal(textOf(empty), "No worktrees yet. Press + to start a ticket.");

  const problem = messageEl(
    ui({ rail: true }),
    "problem",
    "GitHub is down",
    "red",
  );
  assert.equal(textOf(problem), "!");
  assert.equal(problem.$.style.tooltip, "GitHub is down");
});

test("a repo group: its hub's header, then its rows in order", () => {
  const v = view();
  const [g] = v.groups;
  const el = groupEl(ui(), g);
  assert.ok(byId(el, `work-repo-${repo.path}`), "the hub's header");
  assert.equal(
    byId(el, `work-repo-${repo.path}`).style.tooltip,
    "app hub: main",
  );
  assert.equal(byId(el, `work-fold-${repo.path}`).kind, "div");
  assert.equal(byId(el, `work-count-${repo.path}`).style.tooltip, g.count);
  // Each worktree is a row, in the group's order.
  const rows = idsUnder(el, `work-${repo.path}/`).filter(
    (id) => !id.includes("#"),
  );
  assert.deepEqual(
    rows,
    g.worktrees.map((r) => `work-${r.w.path}`),
  );
});

test("a repo group: clicking its header opens the hub; its fold chevron folds the group", () => {
  const [g] = view().groups;
  const el = groupEl(ui(), g);
  const c = cx();
  byId(el, `work-repo-${repo.path}`).on.click({}, c);
  byId(el, `work-fold-${repo.path}`).on.click({}, c);
  assert.deepEqual(calls.splice(0), [
    ["open", "/ws/app"],
    ["fold", repo.path],
  ]);
  assert.equal(c.stopped, true);
});

test("a capped group: a +k more row, which expands the group", () => {
  const v = view({ cap: 1 });
  const [g] = v.groups;
  assert.equal(g.more, 2);
  const el = groupEl(ui(), g);
  const more = byId(el, `work-more-${repo.path}`);
  assert.equal(textOf(el.$.children.at(-1)), "+2 more");
  assert.equal(more.style.tooltip, "Show 2 less recently changed worktrees");
  more.on.click({}, cx());
  assert.deepEqual(calls.splice(0), [["expand", repo.path]]);
});

test("an expanded group past its cap offers Show fewer", () => {
  const v = view({ cap: 1, expanded: new Set([repo.path]) });
  const el = groupEl(ui(), v.groups[0]);
  assert.equal(textOf(el.$.children.at(-1)), "Show fewer");
  assert.equal(
    byId(el, `work-more-${repo.path}`).style.tooltip,
    "Show only the most recently changed",
  );
});

test("a folded group keeps only its header", () => {
  const v = view({ folded: new Set([repo.path]) });
  const el = groupEl(ui(), v.groups[0]);
  assert.deepEqual(idsUnder(el, "work-"), [
    `work-repo-${repo.path}`,
    `work-fold-${repo.path}`,
    // The hub has no space open, so its status says so (a tooltip, by id).
    `work-nospace-${repo.path}`,
    `work-count-${repo.path}`,
  ]);
  assert.equal(el.$.children.length, 1, "the header, and no rows");
});

test("by stage: a plain header, no hub, rows naming their repo", () => {
  const v = view({ by: "stage" });
  const [g] = v.groups;
  assert.equal(g.hub, null);
  const el = groupEl(ui(), g);
  assert.ok(byId(el, `work-group-${g.key}`), "the stage header");
  assert.equal(byId(el, `work-count-${g.key}`).style.tooltip, g.count);
  assert.equal(byId(el, `work-repo-${repo.path}`), null, "no hub header");
});

test("a rail group: a monogram header, a dot per row, the hub's dot first", () => {
  const [g] = view().groups;
  const el = groupEl(ui({ rail: true }), g);
  assert.equal(
    byId(el, `work-repo-${repo.path}`).style.tooltip,
    "app (hub and 3 worktrees)",
  );
  assert.equal(textOf(byId(el, `work-repo-${repo.path}`).children.at(-1)), "A");
  assert.ok(byId(el, `work-${repo.path}`), "the hub's dot");
  for (const r of g.worktrees)
    assert.ok(byId(el, `work-${r.w.path}`), `${r.title}'s dot`);
});

test("a row: its title, its sub line, and a step button per step", () => {
  const v = view({ prs: { [wt(1).path]: PR } });
  const r = v.rows.find((x) => x.w.path === wt(1).path);
  const el = rowEl(ui(), r);
  assert.equal(byId(el, `work-${r.w.path}`).kind, "v_flex");
  assert.match(textOf(el), /#1/);
  assert.match(textOf(el), /Do it/);
  assert.deepEqual(idsUnder(el, `work-step-${r.w.path}-`), [
    `work-step-${r.w.path}-fix-ci`,
    `work-step-${r.w.path}-finish`,
  ]);
  // The next step is the solid one; the rest are quiet.
  assert.equal(byId(el, `work-step-${r.w.path}-fix-ci`).style.bg, "accent");
  assert.equal(byId(el, `work-step-${r.w.path}-finish`).style.bg, "#00000000");
});

test("a row's step button calls step with its row and step", () => {
  const v = view();
  const r = v.rows.find((x) => x.w.path === wt(2).path);
  const el = rowEl(ui(), r);
  const c = cx();
  byId(el, `work-step-${r.w.path}-fix-ci`).on.click({}, c);
  assert.deepEqual(calls.splice(0), [["step", r.w.path, "fix-ci"]]);
  assert.equal(c.stopped, true);
});

test("a row's ↗ menu shows when the row is selected, hovered or its menu is open", () => {
  const v = view({ prs: { [wt(1).path]: PR } });
  const r = v.rows.find((x) => x.w.path === wt(1).path);
  const menu = `work-links-${r.w.path}`;
  assert.equal(byId(rowEl(ui(), r), menu), null, "not selected: a placeholder");
  assert.ok(
    byId(rowEl(ui({ hovered: r.w.path }), r), menu),
    "hovered: the menu",
  );
  const open = rowEl(ui({ linksOpen: r.w.path }), r);
  assert.equal(byId(open, menu).style.open, true);
  assert.equal(
    byId(open, `work-links-button-${r.w.path}`).style.text_color,
    "fg",
  );
});

test("a row's ↗ menu: a link follows it and closes the menu", () => {
  const v = view({ prs: { [wt(1).path]: PR } });
  const r = v.rows.find((x) => x.w.path === wt(1).path);
  const el = rowEl(ui({ hovered: r.w.path }), r);
  const c = cx();
  byId(el, `work-open-pr-${r.w.path}`).on.click({}, c);
  assert.deepEqual(calls.splice(0), [
    ["closeLinks"],
    ["follow", r.w.path, "pr"],
  ]);
  assert.equal(c.stopped, true);
});

test("a row: entering it hovers it; clicking opens it", () => {
  const v = view();
  const r = v.rows.find((x) => x.w.path === wt(3).path);
  const el = rowEl(ui(), r);
  const c = cx();
  el.$.on.hover(true, c);
  el.$.on.click({}, c);
  assert.deepEqual(calls.splice(0), [
    ["hover", r.w.path, true],
    ["open", r.w.path],
  ]);
});

test("a stacked PR: a tree connector (├, or └ for the last), its state and title", () => {
  const v = view({
    prs: { [wt(1).path]: PR },
    stacks: {
      [wt(1).path]: [
        {
          ...PR,
          number: 8,
          title: "Second",
          branch: "issue-1-b",
          state: "MERGED",
        },
        { ...PR, number: 9, title: "Third", branch: "issue-1-c" },
      ],
    },
  });
  const r = v.rows.find((x) => x.w.path === wt(1).path);
  const [a, b] = r.stack;
  const first = subRowEl(ui(), a, false);
  const last = subRowEl(ui(), b, true);
  assert.equal(textOf(first).startsWith("├"), true);
  assert.equal(textOf(last).startsWith("└"), true);
  assert.ok(textOf(first).includes("Second"));
  // A merged PR is dimmed.
  assert.equal(
    byId(first, `work-${a.key}`).children.at(-1).$.style.text_color,
    "dim",
  );
});

test("a stacked PR: a click opens that PR", () => {
  const v = view({
    prs: { [wt(1).path]: PR },
    stacks: { [wt(1).path]: [{ ...PR, number: 8, branch: "issue-1-b" }] },
  });
  const p = v.rows.find((x) => x.w.path === wt(1).path).stack[0];
  const el = subRowEl(ui(), p, true);
  el.$.on.click({}, cx());
  assert.deepEqual(calls.splice(0), [["stacked", p.key]]);
});
