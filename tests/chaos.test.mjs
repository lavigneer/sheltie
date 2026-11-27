// Chaos: the Work sidebar's data under failure. A fake `gh` (gh-fault.mjs)
// answers with 502s, garbage, rate limits or GraphQL errors, and a repo's git
// state can fail; the store must keep every healthy repo's work, never report
// a failed lookup as "no PR", keep what it last knew, and retry later.
// A seeded property test mixes the faults. Set CHAOS_SEED=<n> to replay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { C } from "../src/config.js";
import { PR_MS, RETRY_MS } from "../src/polling.js";
import { prDetailsMany } from "../src/prs.js";
import { fixtureSpaces } from "../src/spaces.js";
import { prRef, WorkStore } from "../src/work.js";
import { WorkModel } from "../src/work-model.js";
import { prNode } from "./fake-tools.mjs";
import { faultyGh } from "./gh-fault.mjs";

const LIVE = fixtureSpaces({});
const tracker = {
  name: "GitHub",
  keysIn: (text) =>
    [...(text ?? "").matchAll(/issue-(\d+)/g)].map((m) => `#${m[1]}`),
  labelOf: (k) => k,
};

// `repos` repos (me/r<i>), each with `per` branches issue-<i*100+b>, every one
// checked out (a work item is a branch with a worktree). Each branch's PR is
// number 1000 + i*100 + b.
function world(repos, per = 2) {
  const list = Array.from({ length: repos }, (_, i) => ({
    slug: `me/r${i}`,
    path: `/ws/r${i}`,
    name: `r${i}`,
    tracker,
  }));
  const branchesOf = (i) =>
    Array.from({ length: per }, (_, b) => `issue-${i * 100 + b}`);
  const prsOf = (i) =>
    branchesOf(i).map((branch, b) => prNode(1000 + i * 100 + b, branch));
  const state = (i) => {
    const names = branchesOf(i);
    return {
      worktrees: names.map((branch) => ({
        path: `/ws/r${i}/.worktrees/${branch}`,
        branch,
        at: 1,
      })),
      branches: new Map(names.map((n) => [n, { local: true }])),
      mainBranch: "main",
      linked: [],
    };
  };
  return { list, branchesOf, prsOf, state };
}

// What the store's join says each branch's PR is: "<slug>#<branch>" -> number
// (null for none). Also checks no item is attached to a branch it doesn't own.
function prsByBranch(store) {
  const out = new Map();
  for (const items of store.join().values())
    for (const it of items)
      if (it.branch)
        out.set(prRef(it.repo.slug, it.branch), it.pr?.number ?? null);
  return out;
}

test("chaos: a repo whose git state fails does not hide the other repos' work", async () => {
  const w = world(3);
  const store = new WorkStore({
    sources: {
      repoState: async (repo) => {
        if (repo.slug === "me/r1") throw new Error("git: index.lock exists");
        return w.state(Number(repo.slug.slice(-1)));
      },
      prDetailsMany: async () => new Map(),
    },
  });
  const model = new WorkModel({ store });
  await model.scan(w.list);
  const keys = [...store.join().keys()];
  assert.ok(keys.includes("#0"), "r0's work is still there");
  assert.ok(keys.includes("#200"), "r2's work is still there");
  assert.ok(!keys.includes("#100"), "r1's work is not invented");
  const view = model.view(LIVE, 0, { width: 400 });
  // Each row's worktree (hub or branch) names its repo.
  const repos = new Set(view.rows.map((r) => r.w?.repo?.slug));
  assert.ok(repos.has("me/r0") && repos.has("me/r2"), "the sidebar shows both");
  assert.ok(!repos.has("me/r1"), "and not the failing repo");
});

test("chaos: a failed lookup keeps the last PR it found, and is retried after RETRY_MS", async () => {
  const gh = faultyGh();
  const clock = { t: 0 };
  const repo = { slug: "me/app", path: "/ws/app", name: "app", tracker };
  const store = new WorkStore({
    sources: {
      repoState: async () => ({
        worktrees: [{ path: "/ws/app/.worktrees/issue-1", branch: "issue-1" }],
        branches: new Map([["issue-1", { local: true }]]),
        mainBranch: "main",
        linked: [],
      }),
      prDetailsMany,
    },
    now: () => clock.t,
  });
  const was = C.programs.gh;
  C.programs.gh = gh.gh;
  try {
    gh.faults({ prs: [prNode(7, "issue-1")] });
    await store.scan([repo]);
    const look = () =>
      store.refresh(new Map(), { branches: [{ repo, branch: "issue-1" }] });
    await look();
    assert.equal(prsByBranch(store).get("me/app#issue-1"), 7);
    assert.equal(gh.graphqlCalls(), 1);

    // GitHub goes down once the PR's details are due again.
    clock.t += PR_MS + 1;
    gh.faults({ down: true, prs: [prNode(7, "issue-1")] });
    await look();
    assert.equal(store.prs.get(prRef("me/app", "issue-1")).state, "failed");
    assert.equal(
      prsByBranch(store).get("me/app#issue-1"),
      7,
      "the last PR it found is kept, not dropped to none",
    );

    // Not retried on every poll: only once the retry window has passed.
    clock.t += 1_000;
    await look();
    assert.equal(gh.graphqlCalls(), 2, "no retry inside RETRY_MS");
    clock.t += RETRY_MS;
    gh.faults({ prs: [prNode(7, "issue-1")] });
    await look();
    assert.equal(gh.graphqlCalls(), 3, "retried once RETRY_MS passed");
    assert.equal(store.prs.get(prRef("me/app", "issue-1")).state, "found");
  } finally {
    C.programs.gh = was;
  }
});

test("chaos: a partial outage fails only the lookups in the chunk it hit", async () => {
  const gh = faultyGh();
  const clock = { t: 0 };
  const repo = { slug: "me/app", path: "/ws/app", name: "app", tracker };
  // 25 branches: three GraphQL queries (10 each). The one that fails is the
  // second; its PRs must be "failed", the rest "found".
  const branches = Array.from({ length: 25 }, (_, i) => `issue-${i}`);
  const prs = branches.map((b, i) => prNode(500 + i, b));
  const store = new WorkStore({
    sources: { repoState: async () => null, prDetailsMany },
    now: () => clock.t,
  });
  const was = C.programs.gh;
  C.programs.gh = gh.gh;
  try {
    gh.faults({ prs, fail: [510] });
    await store.refresh(new Map(), {
      branches: branches.map((branch) => ({ repo, branch })),
    });
    const states = new Map(
      branches.map((b) => [b, store.prs.get(prRef("me/app", b))?.state]),
    );
    assert.equal(states.get("issue-10"), "failed", "the failed lookup");
    assert.equal(states.get("issue-0"), "found");
    assert.equal(states.get("issue-9"), "found");
    assert.equal(states.get("issue-11"), "found", "its chunk-mates");
    assert.equal(states.get("issue-24"), "found", "a later chunk");
    assert.equal(
      [...states.values()].filter((s) => s === "failed").length,
      1,
      "exactly one failed",
    );
  } finally {
    C.programs.gh = was;
  }
});

test("chaos: a garbled answer is a failure, never 'no PR'", async () => {
  const gh = faultyGh();
  const clock = { t: 0 };
  const repo = { slug: "me/app", path: "/ws/app", name: "app", tracker };
  const store = new WorkStore({
    sources: { repoState: async () => null, prDetailsMany },
    now: () => clock.t,
  });
  const was = C.programs.gh;
  C.programs.gh = gh.gh;
  try {
    gh.faults({ garbage: true, prs: [prNode(3, "issue-3")] });
    await store.refresh(new Map(), {
      branches: [{ repo, branch: "issue-3" }],
    });
    const entry = store.prs.get(prRef("me/app", "issue-3"));
    assert.equal(
      entry.state,
      "failed",
      "a non-JSON answer must not read as none",
    );
    assert.equal(entry.value, null);
  } finally {
    C.programs.gh = was;
  }
});

// Seeded property test: random faults on repos and lookups, the invariants
// hold: the scan and render never throw, a healthy lookup's PR shows on its
// branch, a failed one attaches nothing, and a failing repo's branches are
// absent. Runs with the real prDetailsMany against the fake gh.
test("chaos: random faults never break the sidebar's data", async () => {
  const seed = Number(process.env.CHAOS_SEED ?? Date.now() % 2 ** 31) >>> 0;
  let a = seed;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const RUNS = 40;
  for (let run = 0; run < RUNS; run++) {
    const repos = 2 + Math.floor(rand() * 5);
    const w = world(repos, 1 + Math.floor(rand() * 3));
    const badRepos = new Set(
      w.list.filter(() => rand() < 0.2).map((r) => r.slug),
    );
    const all = w.list.flatMap((repo, i) =>
      w.branchesOf(i).map((branch) => ({ repo, branch })),
    );
    const allPRs = w.list.flatMap((_, i) => w.prsOf(i));
    const failing = new Set(
      allPRs.filter(() => rand() < 0.25).map((p) => p.number),
    );
    const gh = faultyGh();
    const clock = { t: 0 };
    const store = new WorkStore({
      sources: {
        repoState: async (repo) => {
          if (badRepos.has(repo.slug)) throw new Error("git broke");
          return w.state(Number(repo.slug.slice("me/r".length)));
        },
        prDetailsMany,
      },
      now: () => clock.t,
    });
    const was = C.programs.gh;
    C.programs.gh = gh.gh;
    try {
      gh.faults({ prs: allPRs, fail: [...failing] });
      const model = new WorkModel({ store });
      await model.scan(w.list);
      await store.refresh(new Map(), {
        branches: all.map(({ repo, branch }) => ({ repo, branch })),
      });
      const view = model.view(LIVE, 0, { width: 400 });
      assert.ok(view, `run ${run}: render`);

      const byBranch = prsByBranch(store);
      for (const { repo, branch } of all) {
        const ref = prRef(repo.slug, branch);
        const got = byBranch.get(ref) ?? null;
        // A branch issue-<k> has the PR 1000 + k (see world()).
        const num = 1000 + Number(branch.slice("issue-".length));
        if (badRepos.has(repo.slug))
          assert.equal(got, null, `run ${run}: ${ref} is in a failing repo`);
        else if (failing.has(num))
          assert.equal(got, null, `run ${run}: ${ref} attached a failed PR`);
        else assert.equal(got, num, `run ${run}: ${ref} lost its PR`);
      }
    } finally {
      C.programs.gh = was;
    }
  }
});

// Last: a rate limit backs off every gh call in this process (lib.js keeps
// that state for the process), so it would fail the tests above it.
test("chaos: a rate limit stops a storm of lookups after a couple of calls", async () => {
  const gh = faultyGh();
  const clock = { t: 0 };
  const repos = Array.from({ length: 30 }, (_, i) => ({
    slug: `me/r${i}`,
    path: `/ws/r${i}`,
    name: `r${i}`,
    tracker,
  }));
  const store = new WorkStore({
    sources: { repoState: async () => null, prDetailsMany },
    now: () => clock.t,
  });
  const was = C.programs.gh;
  C.programs.gh = gh.gh;
  try {
    gh.faults({ rateLimited: true, prs: [] });
    await store.refresh(new Map(), {
      branches: repos.map((repo) => ({ repo, branch: "issue-1" })),
    });
    // 30 repos asked; the limiter runs two at a time and, once one says rate
    // limited, the rest fail without going to GitHub.
    assert.ok(
      gh.graphqlCalls() <= 2,
      `${gh.graphqlCalls()} gh calls reached GitHub during a rate limit`,
    );
    for (const repo of repos)
      assert.equal(store.prs.get(prRef(repo.slug, "issue-1"))?.state, "failed");
  } finally {
    C.programs.gh = was;
  }
});
