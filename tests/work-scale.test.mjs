// The Work sidebar with a large workspace (#219): counts how often the
// expensive work repeats per render, rather than timing it, so it holds on
// any machine.
import assert from "node:assert/strict";
import { test } from "node:test";

const { WorkStore } = await import("../src/work.js");
const { workView } = await import("../src/work-rows.js");

const REPOS = 50;
const BRANCHES = 10;
const WORKTREES = 3;

// A workspace of REPOS repos, each with BRANCHES ticket branches (the first
// WORKTREES checked out). Counts each repo's tracker lookups (trackerOf reads
// repo.tracker) and each join.
function workspace() {
  const counts = { tracker: 0, join: 0 };
  const extra = []; // more branches every repo has (a test adds some)
  const tracker = {
    name: "GitHub",
    keysIn: (text) =>
      [...(text ?? "").matchAll(/issue-(\d+)/g)].map((m) => `#${m[1]}`),
    labelOf: (k) => k,
  };
  const repos = Array.from({ length: REPOS }, (_, r) => {
    const repo = { slug: `me/r${r}`, path: `/ws/r${r}`, name: `r${r}` };
    Object.defineProperty(repo, "tracker", {
      get: () => {
        counts.tracker++;
        return tracker;
      },
    });
    return repo;
  });
  const branchOf = (r, b) => `issue-${r * BRANCHES + b}`;
  const store = new WorkStore({
    sources: {
      repoState: async (repo) => {
        const r = repos.indexOf(repo);
        const names = [
          ...Array.from({ length: BRANCHES }, (_, b) => branchOf(r, b)),
          ...extra,
        ];
        return {
          worktrees: names.slice(0, WORKTREES).map((branch) => ({
            path: `${repo.path}/.worktrees/${branch}`,
            branch,
          })),
          branches: new Map(names.map((n) => [n, { local: true }])),
          mainBranch: "main",
          linked: [],
        };
      },
      prDetails: async () => null,
    },
  });
  const join = store.join.bind(store);
  store.join = () => {
    counts.join++;
    return join();
  };
  return { store, repos, tracker, counts, extra };
}

// Renders every row as the Work sidebar does (work/main.js view and prOf).
function render({ store, repos, tracker }) {
  const groups = repos.map((repo, r) => ({
    repo,
    hub: { path: repo.path, branch: "main", hub: true, repo },
    worktrees: store.states[r].worktrees.map((w) => {
      const key = tracker.keysIn(w.branch)[0];
      return {
        ...w,
        repo,
        handle: { key, label: key, tracker },
      };
    }),
  }));
  return workView({
    groups,
    folded: new Set(),
    width: 400,
    steps: new Map(),
    confirm: null,
    picked: null,
    now: 0,
    spaceOf: () => null,
    stepsOf: () => [],
    prOf: (w) => {
      if (w.hub) return null;
      const own = store.prEntry(w.repo, w.branch)?.value;
      if (own || !w.handle) return own ?? null;
      return (
        store
          .snapshot([w.handle.key])
          .get(w.handle.key)
          ?.find((i) => i.worktree === w.path)?.pr ?? null
      );
    },
    ticketOf: () => null,
    isTicket: (w) => Boolean(w.handle),
    costOf: () => null,
  });
}

test("Work sidebar at scale: one join per render, one tracker lookup per repo", async () => {
  const ws = workspace();
  await ws.store.scan(ws.repos);
  const view = render(ws);
  assert.equal(view.rows.length, REPOS * (WORKTREES + 1));
  assert.ok(ws.counts.join <= 1, `joined ${ws.counts.join} times`);
  assert.ok(
    ws.counts.tracker <= REPOS,
    `looked up trackers ${ws.counts.tracker} times`,
  );
  // Nothing changed: the next render reuses the join.
  render(ws);
  assert.ok(ws.counts.join <= 1, `joined ${ws.counts.join} times`);
});

test("Work sidebar at scale: a scan or lookup that changes something makes the next render join again", async () => {
  const ws = workspace();
  await ws.store.scan(ws.repos);
  render(ws);
  const joined = ws.counts.join;
  // A scan that finds the same: nothing to join again (and nothing new for
  // the view: the store's version stays).
  const version = ws.store.version;
  await ws.store.scan(ws.repos);
  render(ws);
  assert.equal(ws.counts.join, joined);
  assert.equal(ws.store.version, version);
  // A new branch is new.
  ws.extra.push("issue-9999");
  await ws.store.scan(ws.repos);
  render(ws);
  assert.equal(ws.counts.join, joined + 1);
  // A PR lookup (prs cache) changes what is known.
  await ws.store.prs.refresh("me/r0#issue-0", async () => ({
    number: 1,
    branch: "issue-0",
  }));
  render(ws);
  assert.equal(ws.counts.join, joined + 2);
  // The same PR again: nothing new.
  await ws.store.prs.refresh("me/r0#issue-0", async () => ({
    number: 1,
    branch: "issue-0",
  }));
  render(ws);
  assert.equal(ws.counts.join, joined + 2);
});

test("Work sidebar at scale: one read of each kind of Herdr live data per render", async () => {
  const herdr = await import("herdr");
  const { liveData, spaceFor } = await import("../src/lib.js");
  const { agentSaysDone } = await import("../src/flow.js");
  const N = REPOS * WORKTREES;
  const paths = Array.from({ length: N }, (_, i) => `/ws/w${i}`);
  // Every row has a space (found by a pane's cwd, not its folder) whose agent
  // terminal is labelled; even rows say pr=ready.
  const data = {
    spaces: paths.map((_, i) => ({ id: `s${i}`, tabs: [{ id: `t${i}` }] })),
    panes: paths.map((p, i) => ({ tab: `t${i}`, cwd: p, terminal: `a${i}` })),
    agents: [],
    terminals: paths.map((_, i) => ({
      address: `a${i}`,
      labels: { agent: "claude", ...(i % 2 ? {} : { pr: "ready" }) },
    })),
  };
  const reads = { spaces: 0, panes: 0, agents: 0, terminals: 0 };
  for (const k of Object.keys(reads))
    Object.defineProperty(herdr.live, k, {
      configurable: true,
      get: () => {
        reads[k]++;
        return data[k];
      },
    });
  try {
    const live = liveData();
    const done = paths.map((p) => agentSaysDone(spaceFor(p, [], live), live));
    assert.deepEqual(
      done,
      paths.map((_, i) => i % 2 === 0),
    );
    for (const [k, n] of Object.entries(reads))
      assert.ok(n <= 1, `read ${k}() ${n} times for ${N} rows`);
  } finally {
    for (const k of Object.keys(reads))
      Object.defineProperty(herdr.live, k, {
        configurable: true,
        writable: true,
        value: [],
      });
  }
});
