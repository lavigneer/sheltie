// Performance at realistic sizes. Most assertions count work (gh calls, git
// reads, joins), which holds on any machine. The timing checks are for
// catastrophic regressions only: a ratio between two sizes (linear work grows
// about 4x for 4x the input, quadratic about 16x) and budgets an order of
// magnitude above what the code takes. Each measured time is also logged to
// the test output, so a slow run shows its numbers, and compared with
// perf-baseline.json by the last test (baseline.mjs: fails past 2x).
import assert from "node:assert/strict";
import { test } from "node:test";
import { C } from "../src/config.js";
import { parseWorktrees } from "../src/git.js";
import { score } from "../src/lib.js";
import { PR_MS } from "../src/polling.js";
import { PRS_PER_QUERY, prDetailsMany, probePRs } from "../src/prs.js";
import { fixtureSpaces } from "../src/spaces.js";
import { prRef, WorkStore } from "../src/work.js";
import { WorkModel } from "../src/work-model.js";
import { compare, record } from "./baseline.mjs";
import { prNode } from "./fake-tools.mjs";
import { faultyGh } from "./gh-fault.mjs";

const LIVE = fixtureSpaces({});
const tracker = {
  name: "GitHub",
  keysIn: (text) =>
    [...(text ?? "").matchAll(/issue-(\d+)/g)].map((m) => `#${m[1]}`),
  labelOf: (k) => k,
};

// `repos` repos, each with `per` checked-out branches issue-<i*per+b>.
function workspace(repos, per) {
  const list = Array.from({ length: repos }, (_, i) => ({
    slug: `me/r${i}`,
    path: `/ws/r${i}`,
    name: `r${i}`,
    tracker,
  }));
  const counts = { repoState: 0 };
  const store = new WorkStore({
    sources: {
      repoState: async (repo) => {
        counts.repoState++;
        const i = list.indexOf(repo);
        const names = Array.from(
          { length: per },
          (_, b) => `issue-${i * per + b}`,
        );
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
      },
      prDetailsMany: async () => new Map(),
    },
  });
  return { list, counts, store, model: new WorkModel({ store }) };
}

// The median of `n` runs of `f`, in ms.
function medianMs(f, n = 5) {
  const times = Array.from({ length: n }, () => {
    const t = performance.now();
    f();
    return performance.now() - t;
  });
  return times.sort((a, b) => a - b)[Math.floor(n / 2)];
}

test("performance: 250 PR lookups in one repo cost one GraphQL query per PRS_PER_QUERY, then none while fresh, and a probe per 100 when due", async () => {
  const gh = faultyGh();
  const clock = { t: 0 };
  const repo = { slug: "me/app", path: "/ws/app", name: "app", tracker };
  const branches = Array.from({ length: 250 }, (_, i) => `issue-${i}`);
  const store = new WorkStore({
    sources: {
      repoState: async () => null,
      prDetailsMany,
      prProbeMany: probePRs,
    },
    now: () => clock.t,
  });
  const was = C.programs.gh;
  C.programs.gh = gh.gh;
  try {
    gh.faults({ prs: branches.map((b, i) => prNode(500 + i, b)) });
    const look = () =>
      store.refresh(new Map(), {
        branches: branches.map((branch) => ({ repo, branch })),
      });
    const t0 = performance.now();
    await look();
    const took = performance.now() - t0;
    // The budget is a fixed number, not PRS_PER_QUERY: changing the batch size
    // should change this test too.
    const queries = Math.ceil(250 / PRS_PER_QUERY);
    assert.equal(gh.graphqlCalls(), queries, "one query per PRS_PER_QUERY PRs");
    assert.equal(store.prs.get(prRef("me/app", "issue-249"))?.state, "found");
    record("250 PR lookups", took);
    console.log(`  250 PR lookups: ${took.toFixed(0)} ms, ${queries} gh calls`);

    // Still fresh a moment later: nothing goes to GitHub.
    clock.t += PR_MS - 1;
    await look();
    assert.equal(gh.graphqlCalls(), queries, "fresh PRs are not asked again");

    // Due, and not changed since (updatedAt): the probe answers for all 250
    // in 3 queries, and no PR is looked up in full.
    clock.t += 2;
    await look();
    assert.equal(
      gh.graphqlCalls(),
      queries + Math.ceil(250 / 100),
      "due PRs are probed, not looked up in full",
    );
    assert.equal(store.prs.get(prRef("me/app", "issue-249"))?.state, "found");
  } finally {
    C.programs.gh = was;
  }
});

test("performance: a scan reads each repo's git state once, at 300 repos", async () => {
  const w = workspace(300, 3);
  await w.model.scan(w.list);
  assert.equal(w.counts.repoState, 300, "one read per repo");
  w.counts.repoState = 0;
  const view = w.model.view(LIVE, 0, { width: 400 });
  assert.equal(w.counts.repoState, 0, "rendering reads no git state");
  assert.ok(view.rows.length >= 300 * 4, "every repo's rows are there");
});

test("performance: scan and join grow linearly with the workspace, not quadratically", async () => {
  // 4x the repos: linear work is ~4x the time, quadratic ~16x.
  const small = workspace(100, 10);
  const large = workspace(400, 10);
  await small.model.scan(small.list);
  await large.model.scan(large.list);
  const tSmall = medianMs(() => small.store.join());
  const tLarge = medianMs(() => large.store.join());
  const ratio = tLarge / Math.max(tSmall, 0.05);
  record("join 100x10", tSmall);
  record("join 400x10", tLarge);
  console.log(
    `  join 100x10: ${tSmall.toFixed(1)} ms, 400x10: ${tLarge.toFixed(1)} ms (x${ratio.toFixed(1)})`,
  );
  assert.ok(
    ratio < 10,
    `joining 4x the repos took ${ratio.toFixed(1)}x as long`,
  );
});

test("performance: the hot paths stay well inside budget at 10x the sizes above", async () => {
  const w = workspace(1000, 10);
  await w.model.scan(w.list);
  const join = medianMs(() => w.store.join());
  record("join 1000x10", join);
  console.log(`  join 1000x10: ${join.toFixed(1)} ms`);
  assert.ok(join < 1000, `join of 10,000 worktrees took ${join.toFixed(0)} ms`);

  const n = 20_000;
  const porcelain = Array.from(
    { length: n },
    (_, i) =>
      `worktree /r/.worktrees/w${i}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/issue-${i}\n`,
  ).join("\n");
  const parse = medianMs(() => parseWorktrees(porcelain, "/r"));
  record("parseWorktrees 20000", parse);
  console.log(`  parseWorktrees ${n}: ${parse.toFixed(1)} ms`);
  assert.ok(parse < 500, `parseWorktrees of ${n} took ${parse.toFixed(0)} ms`);

  const texts = Array.from(
    { length: n },
    (_, i) => `issue-${i} add the thing ${i}`,
  );
  const fuzzy = medianMs(() => {
    for (const t of texts) score(t, "thing 42");
  });
  record("score 20000", fuzzy);
  console.log(`  score ${n} strings: ${fuzzy.toFixed(1)} ms`);
  assert.ok(fuzzy < 500, `scoring ${n} strings took ${fuzzy.toFixed(0)} ms`);
});

// Last: every time above against the baseline (see baseline.mjs). Printed on
// every run; fails only with PERF_COMPARE=1 (CI's own step, without the
// coverage run's instrumentation, on the machine the baseline came from).
test("performance: no phase is more than 2x its baseline", () => {
  const slow = compare(new URL("perf-baseline.json", import.meta.url).pathname);
  if (process.env.PERF_COMPARE === "1")
    assert.deepEqual(slow, [], `slower than the baseline:\n${slow.join("\n")}`);
});
