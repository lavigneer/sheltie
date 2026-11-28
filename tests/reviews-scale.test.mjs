// The Reviews sidebar at scale (#367): 500 review requests over 50 repos, with
// a review worktree for many of them. Counts the lookups per refresh rather
// than timing them, so it holds on any machine; the one timing check is a
// ratio between two sizes (linear ~4x for 4x the input, quadratic ~16x).
import assert from "node:assert/strict";
import { test } from "node:test";

const { RepoCache } = await import("../src/polling.js");
const { ReviewsModel } = await import("../src/reviews-model.js");
const { reviewsView } = await import("../src/reviews-rows.js");

const REPOS = 50;

const slugOf = (/** @type {number} */ i) => `acme/r${i % REPOS}`;
// A review-request search node (prs.js REVIEW_SEARCH) for PR i.
const node = (/** @type {number} */ i, title = `PR ${i}`) => ({
  number: 1000 + i,
  url: `https://github.com/${slugOf(i)}/pull/${1000 + i}`,
  title,
  additions: i,
  deletions: 1,
  createdAt: "2026-01-01T00:00:00Z",
  repository: { nameWithOwner: slugOf(i) },
  author: { login: `dev${i % 7}` },
  timelineItems: {
    nodes: [
      {
        createdAt: new Date(Date.UTC(2026, 0, 2) + i * 60_000).toISOString(),
        requestedReviewer: { __typename: "User", login: "me" },
      },
    ],
  },
  latestReviews: { nodes: [] },
});

// A model of `n` requests, with a review worktree for every `everyNth` one,
// and counts of each source's calls. `st.titles` overrides a PR's title.
function setup(n, everyNth = 2) {
  const repos = Array.from({ length: REPOS }, (_, i) => ({
    slug: `acme/r${i}`,
    path: `/ws/r${i}`,
    name: `r${i}`,
  }));
  const st = {
    n,
    titles: /** @type {Map<number, string>} */ (new Map()),
    counts: { finds: 0, requests: 0, worktrees: 0, sweep: 0 },
  };
  const worktrees = Array.from({ length: Math.ceil(n / everyNth) }, (_, k) => {
    const i = k * everyNth;
    return {
      path: `/ws/r${i % REPOS}/.worktrees/review-${1000 + i}`,
      slug: slugOf(i),
      number: 1000 + i,
      repo: repos[i % REPOS],
    };
  });
  const model = new ReviewsModel({
    repos: new RepoCache({
      find: async () => {
        st.counts.finds++;
        return repos;
      },
    }),
    sources: {
      ready: async () => {},
      requests: async () => {
        st.counts.requests++;
        return {
          viewer: { login: "me" },
          search: {
            nodes: Array.from({ length: st.n }, (_, i) =>
              node(i, st.titles.get(i)),
            ),
          },
        };
      },
      worktrees: async () => {
        st.counts.worktrees++;
        return worktrees;
      },
      sweep: async (/** @type {any[]} */ all) => {
        st.counts.sweep++;
        return { kept: all, refused: [] };
      },
      notify: () => {},
    },
  });
  return { model, st, worktrees };
}

const render = (/** @type {ReviewsModel} */ model) =>
  reviewsView({
    width: 400,
    now: Date.UTC(2026, 0, 3),
    queue: model.queue,
    reviewed: model.reviewed,
    worktreeOf: (r) => model.worktreeOf(r),
  });

test("Reviews at scale: one search and one sweep per refresh, repos found once while fresh", async () => {
  const { model, st } = setup(500);
  await model.refresh();
  assert.deepEqual(st.counts, {
    finds: 1,
    requests: 1,
    worktrees: 1,
    sweep: 1,
  });
  assert.equal(model.count, 500);
  // The polls after it: one search and sweep each, the repos reused.
  for (let i = 0; i < 5; i++) await model.refresh();
  assert.deepEqual(st.counts, {
    finds: 1,
    requests: 6,
    worktrees: 6,
    sweep: 6,
  });
  // Forced (the refresh button): the repos are found again.
  await model.refresh(true);
  assert.equal(st.counts.finds, 2);
});

test("Reviews at scale: every request is a row, in request order, its worktree found", async () => {
  const { model } = setup(500);
  await model.refresh();
  const { rows } = render(model);
  assert.equal(rows.length, 500);
  assert.equal(rows[0].pr.number, 1000, "oldest request first");
  assert.equal(rows.at(-1)?.pr.number, 1499);
  assert.equal(rows.filter((r) => r.done).length, 250, "every 2nd has one");
  assert.equal(new Set(rows.map((r) => r.key)).size, 500, "keys are unique");
});

test("Reviews at scale: a refresh that finds the same queue changes nothing; one changed PR does", async () => {
  const { model, st } = setup(500);
  await model.refresh();
  const version = model.cache.version;
  const queue = model.queue;
  await model.refresh();
  assert.equal(model.cache.version, version, "same answer: nothing new");
  st.titles.set(42, "PR 42, renamed");
  await model.refresh();
  assert.equal(model.cache.version, version + 1, "one PR changed: new");
  assert.equal(model.queue.length, queue.length);
  assert.equal(
    model.queue.find((r) => r.number === 1042)?.title,
    "PR 42, renamed",
  );
  assert.equal(st.counts.requests, 3, "still one search per refresh");
});

// The median time of `n` runs of `f`, in ms.
async function medianMs(/** @type {() => any} */ f, n = 5) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await f();
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[Math.floor(n / 2)];
}

test("Reviews at scale: refresh and render grow linearly with the queue and its worktrees", async () => {
  // Every PR has a review worktree, so worktreeOf and the sweep's queue check
  // both see the most work.
  const small = setup(500, 1);
  const large = setup(2000, 1);
  const tSmall = await medianMs(async () => {
    await small.model.refresh();
    render(small.model);
  });
  const tLarge = await medianMs(async () => {
    await large.model.refresh();
    render(large.model);
  });
  const ratio = tLarge / Math.max(tSmall, 0.05);
  console.log(
    `  reviews refresh+render 500: ${tSmall.toFixed(1)} ms, 2000: ${tLarge.toFixed(1)} ms (x${ratio.toFixed(1)})`,
  );
  assert.ok(ratio < 10, `4x the reviews took ${ratio.toFixed(1)}x as long`);
});

test("Reviews at scale: the sweep looks reviewed PRs up once per repo, not once per worktree", async () => {
  const { sweepReviews } = await import("../src/start.js");
  // 500 review worktrees, half still queued; the other 250 (in all 50
  // repos) are looked up, their PRs still open.
  const { worktrees } = setup(500, 1);
  const queue = worktrees
    .filter((_, i) => Math.floor(i / REPOS) % 2 === 0)
    .map((w) => ({ slug: w.slug.toUpperCase(), number: w.number }));
  /** @type {[string, number[]][]} */
  const calls = [];
  const { kept, refused } = await sweepReviews(
    worktrees,
    queue,
    async (slug, numbers) => {
      calls.push([slug, numbers]);
      return new Map(
        numbers.map((n) => [n, { state: "OPEN", title: `PR ${n}`, url: "u" }]),
      );
    },
  );
  assert.equal(calls.length, REPOS, "one lookup per repo");
  assert.equal(
    calls.flatMap(([, ns]) => ns).length,
    250,
    "each reviewed PR asked once, no queued one",
  );
  assert.equal(kept.length, 250);
  assert.equal(refused.length, 0);
  assert.equal(kept[0].title, `PR ${kept[0].number}`);
});

test("Reviews at scale: a repo whose lookup fails fails the sweep, so the last worktrees stay", async () => {
  const { sweepReviews } = await import("../src/start.js");
  const { worktrees } = setup(10, 1);
  await assert.rejects(
    sweepReviews(
      worktrees,
      [],
      async (_slug, numbers) =>
        new Map(numbers.map((n) => [n, new Error("HTTP 502")])),
    ),
    /HTTP 502/,
  );
});
