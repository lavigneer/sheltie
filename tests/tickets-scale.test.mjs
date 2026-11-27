// The Tickets popup's load at scale (#367): 2,000 open issues over 50 repos
// (each repo with its own tracker, as GitHub issues are), each issue linking a
// PR, and 20 worktrees per repo. Counts the tracker and gh lookups per load
// (work.js workFor, which tickets/main.js load() runs), not their time.
import assert from "node:assert/strict";
import { test } from "node:test";

const { PR_MS, WorkStore, workFor } = await import("../src/work.js");
const { TicketsModel, advance, reloading } = await import(
  "../src/tickets-model.js"
);
const { perRef } = await import("./fake-tools.mjs");

const REPOS = 50;
const ISSUES = 40; // per repo: 2,000 in all
const WORKTREES = 20;

function workspace(now = Date.now) {
  const counts = {
    linkedPRs: /** @type {string[][]} */ ([]),
    prDetailsMany: /** @type {[string, (string | number)[]][]} */ ([]),
    repoState: 0,
    join: 0,
  };
  // Linked PR per issue key (a test may change one).
  /** @type {Map<string, { slug: string, number: number }[]>} */
  const links = new Map();
  const repos = Array.from({ length: REPOS }, (_, r) => {
    const slug = `acme/r${r}`;
    /** @type {any} */
    const repo = { slug, path: `/ws/r${r}`, name: `r${r}` };
    repo.tracker = {
      name: "GitHub",
      keysIn: (/** @type {string | null} */ text) =>
        [...(text ?? "").matchAll(/issue-(\d+)/g)].map(
          (m) => `${slug}#${m[1]}`,
        ),
      labelOf: (/** @type {string} */ k) => k,
      linkedPRs: async (/** @type {string[]} */ keys) => {
        counts.linkedPRs.push(keys);
        return new Map(keys.map((k) => [k, links.get(k) ?? []]));
      },
    };
    return repo;
  });
  const tickets = repos.flatMap((repo) =>
    Array.from({ length: ISSUES }, (_, i) => {
      const key = `${repo.slug}#${i}`;
      // Issues past the worktrees have only their linked PR (no local work).
      links.set(key, [{ slug: repo.slug, number: 5000 + i }]);
      return { key, label: key, title: `Issue ${i}`, tracker: repo.tracker };
    }),
  );
  const store = new WorkStore({
    now,
    sources: {
      repoState: async (/** @type {any} */ repo) => {
        counts.repoState++;
        const names = Array.from({ length: WORKTREES }, (_, b) => `issue-${b}`);
        return {
          worktrees: names.map((branch) => ({
            path: `${repo.path}/.worktrees/${branch}`,
            branch,
          })),
          branches: new Map(names.map((n) => [n, { local: true }])),
          mainBranch: "main",
          linked: [],
        };
      },
      prDetailsMany: async (
        /** @type {string} */ slug,
        /** @type {{ ref: string | number }[]} */ items,
        /** @type {any} */ opts,
      ) => {
        counts.prDetailsMany.push([slug, items.map((i) => i.ref)]);
        return perRef(async (s, ref) =>
          typeof ref === "number"
            ? { slug: s, number: ref, branch: `issue-${ref - 5000}` }
            : { slug: s, number: 5000 + Number(ref.slice(6)), branch: ref },
        )(slug, items, opts);
      },
    },
  });
  const join = store.join.bind(store);
  store.join = () => {
    counts.join++;
    return join();
  };
  return { repos, tickets, store, counts, links };
}

test("Tickets at scale: a load asks each tracker once and gh once per repo", async () => {
  const ws = workspace();
  const phases = /** @type {string[]} */ ([]);
  const work = await workFor(ws.tickets, ws.repos, {
    store: ws.store,
    onLocal: () => phases.push("local"),
    onLinked: () => phases.push("linked"),
  });
  assert.deepEqual(phases, ["local", "linked"]);
  assert.equal(ws.counts.repoState, REPOS, "one git read per repo");
  assert.equal(ws.counts.linkedPRs.length, REPOS, "one call per tracker");
  assert.equal(
    ws.counts.linkedPRs.flat().length,
    REPOS * ISSUES,
    "each ticket asked about once",
  );
  assert.equal(ws.counts.prDetailsMany.length, REPOS, "one lookup per repo");
  // Each repo, in its one lookup: its 20 branches, and every issue's linked
  // PR by number. A first load can't know yet that a branch's PR is the one
  // its issue links, so the first 20 are asked both ways (in the same query).
  for (const [, refs] of ws.counts.prDetailsMany)
    assert.equal(refs.length, WORKTREES + ISSUES);
  assert.equal(work.size, REPOS * ISSUES);
  // Local work and its PR are one item, not two.
  const first = work.get("acme/r0#0") ?? [];
  assert.equal(first.length, 1);
  assert.equal(first[0].worktree, "/ws/r0/.worktrees/issue-0");
  assert.equal(first[0].pr?.number, 5000);
  // A ticket with only a linked PR has that as its work.
  const late = work.get(`acme/r0#${ISSUES - 1}`) ?? [];
  assert.deepEqual(
    late.map((w) => [w.worktree, w.pr?.number]),
    [[null, 5000 + ISSUES - 1]],
  );
  // The join runs when something new lands, not per ticket: once per tracker
  // answer (warm, #282) and a few around them, never 2,000 times.
  assert.ok(
    ws.counts.join <= REPOS + 4,
    `joined ${ws.counts.join} times for ${REPOS} trackers`,
  );
  console.log(
    `  tickets load ${REPOS * ISSUES} issues: ${ws.counts.join} joins, ${ws.counts.prDetailsMany.length} gh lookups`,
  );
});

test("Tickets at scale: nothing is asked again while fresh", async () => {
  const ws = workspace();
  await workFor(ws.tickets, ws.repos, { store: ws.store });
  const keys = new Map(ws.tickets.map((t) => [t.key, t.tracker]));
  ws.counts.linkedPRs = [];
  ws.counts.prDetailsMany = [];
  const joins = ws.counts.join;
  await ws.store.refresh(keys);
  assert.equal(ws.counts.linkedPRs.length, 0, "no tracker call");
  assert.equal(ws.counts.prDetailsMany.length, 0, "no gh call");
  ws.store.snapshot(ws.tickets.map((t) => t.key));
  assert.equal(ws.counts.join, joins, "nothing new: no join");
});

test("Tickets at scale: one ticket's new link is one tracker call and one gh call", async () => {
  const ws = workspace();
  await workFor(ws.tickets, ws.repos, { store: ws.store });
  ws.counts.linkedPRs = [];
  ws.counts.prDetailsMany = [];
  const key = "acme/r7#33";
  ws.links.set(key, [
    { slug: "acme/r7", number: 5033 },
    { slug: "acme/r7", number: 9000 },
  ]);
  const t = ws.tickets.find((x) => x.key === key);
  await ws.store.refresh(new Map([[key, t?.tracker]]), { force: true });
  assert.deepEqual(ws.counts.linkedPRs, [[key]]);
  assert.equal(ws.counts.prDetailsMany.length, 1);
  assert.deepEqual(ws.counts.prDetailsMany[0][1].sort(), [5033, 9000]);
  const work = ws.store.snapshot([key]).get(key) ?? [];
  assert.deepEqual(work.map((w) => w.pr?.number).sort(), [5033, 9000]);
});

test("Tickets at scale: the model moves through its phases once per load, its list intact", async () => {
  const ws = workspace();
  const model = new TicketsModel();
  let changes = 0;
  const on = { changed: () => changes++ };
  let data = reloading(1);
  model.setData(data, on);
  data = advance(data, "listed", {
    tickets: ws.tickets,
    repos: ws.repos,
    here: null,
    work: new Map(),
  });
  model.setData(data, on);
  const work = await workFor(ws.tickets, ws.repos, {
    store: ws.store,
    onLocal: (w) => {
      data = advance(data, "local", { work: w });
      model.setData(data, on);
    },
    onLinked: (linked) => {
      data = advance(data, "linked", { linked });
      model.setData(data, on);
    },
  });
  model.setData(advance(data, "ready", { work }), on);
  assert.equal(changes, 5, "one redraw per phase, not per ticket");
  assert.equal(model.data.phase, "ready");
  assert.equal(model.data.tickets.length, REPOS * ISSUES);
  assert.equal(model.workOf({ key: "acme/r49#0" })[0]?.pr?.number, 5000);
});

test("Tickets at scale: once due, each PR is asked again under one ref, not two", async () => {
  const clock = { t: 1_000_000 };
  const ws = workspace(() => clock.t);
  await workFor(ws.tickets, ws.repos, { store: ws.store });
  const keys = new Map(ws.tickets.map((t) => [t.key, t.tracker]));
  for (let poll = 0; poll < 3; poll++) {
    clock.t += PR_MS + 1;
    ws.counts.prDetailsMany = [];
    await ws.store.refresh(keys);
    assert.equal(ws.counts.prDetailsMany.length, REPOS, `poll ${poll}`);
    const [, refs] = ws.counts.prDetailsMany[0];
    // Branches by name (their PRs are the first 20 issues' links), the
    // other 20 issues' PRs by number: 40 refs for 40 PRs.
    assert.equal(refs.length, ISSUES, `poll ${poll}: ${refs.join(" ")}`);
    assert.equal(refs.filter((r) => typeof r === "number").length, 20);
  }
});
