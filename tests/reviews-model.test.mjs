// ReviewsModel and the shared polling pieces (#251): queue, sweep, start and
// done, with no View.
import assert from "node:assert/strict";
import { test } from "node:test";

const { RepoCache, reportFailure } = await import("../src/polling.js");
const { ReviewsModel } = await import("../src/reviews-model.js");

const REPO = { slug: "acme/web", path: "/src/web" };
const prNode = (number) => ({
  number,
  url: `https://github.com/acme/web/pull/${number}`,
  title: `PR ${number}`,
  additions: 1,
  deletions: 1,
  createdAt: "2026-01-01T00:00:00Z",
  repository: { nameWithOwner: "acme/web" },
  author: { login: "someone" },
  timelineItems: {
    nodes: [
      {
        createdAt: "2026-01-02T00:00:00Z",
        requestedReviewer: { __typename: "User", login: "me" },
      },
    ],
  },
  latestReviews: { nodes: [] },
});
const wt = (number) => ({
  path: `/wt/review-${number}`,
  slug: "acme/web",
  number,
  repo: REPO,
});

// A model whose sources are fakes; `s` changes what they return.
function setup(s = {}) {
  const st = {
    queued: [1],
    worktrees: [],
    closed: new Set(), // PR numbers merged/closed
    refuse: new Set(), // teardowns that throw
    requestsFail: false,
    notes: [],
    records: [],
    opened: [],
    finds: 0,
    ...s,
  };
  const model = new ReviewsModel({
    repos: new RepoCache({
      find: async () => {
        st.finds++;
        return [REPO];
      },
    }),
    sources: {
      ready: async () => {},
      requests: async () => {
        if (st.requestsFail) throw new Error("offline");
        return {
          viewer: { login: "me" },
          search: { nodes: st.queued.map(prNode) },
        };
      },
      worktrees: async () => st.worktrees,
      sweep: async (all, queue) => {
        const kept = [];
        const refused = [];
        for (const w of all) {
          if (queue.some((r) => r.number === w.number)) continue;
          if (st.closed.has(w.number)) {
            if (st.refuse.has(w.number)) {
              refused.push({ ...w, why: "dirty" });
              kept.push(w);
            } else st.worktrees = st.worktrees.filter((x) => x !== w);
          } else kept.push(w);
        }
        return { kept, refused };
      },
      finish: async (_repo, w) => {
        if (st.refuse.has(w.number)) throw new Error("dirty\nmore");
      },
      prepare: async (r) => ({ path: `/wt/review-${r.number}` }),
      open: (list) => st.opened.push(...list),
      notify: (n) => st.notes.push(n),
      record: (...a) => st.records.push(a),
    },
  });
  return { model, st };
}

test("RepoCache finds once until forced or stale", async () => {
  let t = 0;
  let finds = 0;
  const c = new RepoCache({
    find: async () => [{ n: ++finds }],
    maxAge: 100,
    now: () => t,
  });
  assert.deepEqual(c.list, []);
  await c.get();
  await c.get();
  assert.equal(finds, 1);
  await c.get(true);
  assert.equal(finds, 2);
  t = 100;
  await c.get();
  assert.equal(finds, 3);
  assert.deepEqual(c.list, [{ n: 3 }]);
});

test("reportFailure records and tells the first line", () => {
  const recs = [];
  const notes = [];
  reportFailure(
    {
      mod: "m",
      what: "w",
      title: "T",
      error: new Error("a\nb"),
      context: { x: 1 },
    },
    { record: (...a) => recs.push(a), notify: (n) => notes.push(n) },
  );
  assert.equal(recs[0][0], "m");
  assert.deepEqual(recs[0][3], { x: 1 });
  assert.deepEqual(notes, [{ title: "T", body: "a", level: "error" }]);
});

test("the queue loads, counts and survives a failed refresh", async () => {
  const { model, st } = setup({ queued: [1, 2] });
  assert.equal(model.count, null);
  await model.refresh();
  assert.equal(model.count, 2);
  assert.equal(model.failed, false);
  st.requestsFail = true;
  await model.refresh(true);
  assert.equal(model.failed, true);
  assert.deepEqual(
    model.queue.map((r) => r.number),
    [1, 2],
  );
});

test("repos are found again only when forced", async () => {
  const { model, st } = setup();
  await model.refresh();
  await model.refresh();
  assert.equal(st.finds, 1);
  await model.refresh(true);
  assert.equal(st.finds, 2);
});

test("a queued PR's worktree stays: its row gets ✓", async () => {
  const { model } = setup({ queued: [1], worktrees: [wt(1)] });
  await model.refresh();
  assert.equal(
    model.worktreeOf({ slug: "ACME/web", number: 1 })?.path,
    wt(1).path,
  );
  assert.deepEqual(model.reviewed, []);
});

test("sweep: reviewed kept, closed torn down, refusal told once", async () => {
  const { model, st } = setup({
    queued: [],
    worktrees: [wt(2), wt(3), wt(4)],
    closed: new Set([3, 4]),
    refuse: new Set([4]),
  });
  await model.refresh();
  assert.deepEqual(
    model.worktrees.map((w) => w.number),
    [2, 4],
  );
  assert.deepEqual(
    model.reviewed.map((w) => w.number),
    [2, 4],
  );
  await model.refresh();
  assert.equal(st.notes.filter((n) => n.level === "warning").length, 1);
});

test("start opens the review; one at a time; unknown repo fails", async () => {
  const { model, st } = setup();
  await model.refresh();
  const a = model.start({ slug: "acme/web", number: 1 });
  assert.equal(await model.start({ slug: "acme/web", number: 1 }), false);
  assert.equal(await a, true);
  assert.deepEqual(st.opened, [{ path: "/wt/review-1" }]);
  await model.start({ slug: "other/x", number: 9 });
  assert.equal(st.records[0][1], "start review");
  assert.equal(st.notes.at(-1).title, "other/x#9: couldn't start the review");
  assert.equal(model.starting, false);
});

test("done removes the worktree, or reports a refusal", async () => {
  const { model, st } = setup({
    queued: [],
    worktrees: [wt(2), wt(5)],
    refuse: new Set([5]),
  });
  await model.refresh();
  assert.equal(await model.done(wt(2)), true);
  assert.deepEqual(
    model.reviewed.map((w) => w.number),
    [5],
  );
  assert.equal(await model.done(wt(5)), false);
  assert.equal(model.reviewed.length, 1);
  assert.deepEqual(st.records[0][3], { pr: "acme/web#5" });
  assert.equal(st.notes.at(-1).body, "dirty");
});
