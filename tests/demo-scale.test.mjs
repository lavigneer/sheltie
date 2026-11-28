// The demo at scale (#369): a fixture from scripts/gen-scale-fixture.mjs
// (50 repos x 20 worktrees, 2,000 issues, 50 review requests), made into a
// demo with `herdr-demo --prepare --fixture`, then the Tickets load, the Work
// sidebar and the Reviews queue against the demo's fake gh, through the real
// code. Checks that each renders everything, and that the fakes stay fast
// enough to try the mods with (each phase is timed and logged).
//
// Creating the demo's repos takes a minute, so this runs only with
// SHELTIE_SCALE=1 (npm run test:scale, as in CI).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { scaleFixture } from "../scripts/gen-scale-fixture.mjs";
import { prepare } from "./demo.mjs";

const ON = process.env.SHELTIE_SCALE === "1";
const skip = ON ? false : "set SHELTIE_SCALE=1 (npm run test:scale)";
const SIZES = { repos: 50, worktrees: 20, issues: 2000, reviews: 50 };
const PRS = SIZES.repos * (SIZES.worktrees / 2); // every other worktree
// Budgets, an order of magnitude above what they take (the fakes are bash
// and jq): a call that grew with the state's size per PR would blow them.
const CALL_MS = 3_000;
const LOAD_MS = 60_000;
// The Work sidebar's lookups still view each worktree's ticket with its own gh
// call (tracker.view, 1,000 here: ~65 s against the fake). Until those are
// batched as linkedPRs is, this guards only against it getting worse.
const WORK_LOOKUPS_MS = 180_000;

/** @type {Record<string, number>} */
const took = {};
/** @template T @param {string} phase @param {() => Promise<T>} f @returns {Promise<T>} */
async function timed(phase, f) {
  const t = performance.now();
  const out = await f();
  took[phase] = performance.now() - t;
  console.log(`  ${phase}: ${took[phase].toFixed(0)} ms`);
  return out;
}

/** @type {any} */
let M;
before(async () => {
  if (!ON) return;
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "sheltie-scale-")),
    "data-scale.json",
  );
  fs.writeFileSync(file, JSON.stringify(scaleFixture(SIZES)));
  await timed("herdr-demo --prepare", async () =>
    prepare("github", ["--fixture", file]),
  );
  const config = await import("../src/config.js");
  await config.configReady();
  M = {
    ...(await import("../src/git.js")),
    ...(await import("../src/prs.js")),
    ...(await import("../src/work.js")),
    ...(await import("../src/work-model.js")),
    ...(await import("../src/reviews-rows.js")),
    ...(await import("../src/spaces.js")),
  };
});

test("demo at scale: the generator makes what was asked", () => {
  const f = scaleFixture(SIZES);
  assert.equal(f.repos.length, SIZES.repos);
  assert.equal(f.issues?.length, SIZES.issues);
  assert.ok(f.repos.every((r) => r.worktrees.length === SIZES.worktrees));
  assert.equal(f.prs.filter((p) => !p.author).length, PRS);
  assert.equal(f.prs.filter((p) => p.author).length, SIZES.reviews);
  const jira = scaleFixture({ ...SIZES, tracker: "jira" });
  assert.equal(jira.tickets?.length, SIZES.issues);
  assert.equal(jira.settings.repoRules?.length, SIZES.repos);
});

test("demo at scale: tickets, Work and Reviews load everything, the fakes fast", {
  skip,
}, async () => {
  const repos = await timed("localRepos", () => M.localRepos());
  assert.equal(repos.length, SIZES.repos);

  const tickets = await timed("issue list", () => M.listTickets(repos));
  assert.equal(tickets.length, SIZES.issues);
  assert.ok(took["issue list"] < CALL_MS);

  // The Tickets popup's load: local work, linked PRs, every PR's details.
  const work = await timed("tickets load", () => M.workFor(tickets, repos));
  assert.ok(took["tickets load"] < LOAD_MS);
  const withPR = [...work.values()].filter((items) =>
    items.some((/** @type {any} */ w) => w.pr),
  );
  assert.equal(withPR.length, PRS, "every PR found, on its ticket");

  // The Work sidebar: a scan, its lookups, then a render of every row.
  const model = new M.WorkModel();
  await timed("work scan", () => model.scan(repos));
  await timed("work lookups", () => model.lookups(true));
  assert.ok(took["work lookups"] < WORK_LOOKUPS_MS);
  const view = await timed("work render", async () =>
    model.view(M.fixtureSpaces({}), 0, {
      width: 400,
      armed: () => false,
    }),
  );
  assert.ok(
    view.rows.length >= SIZES.repos * (SIZES.worktrees + 1),
    `${view.rows.length} rows`,
  );

  // The Reviews queue.
  const data = await timed("review search", () => M.reviewRequests("x"));
  assert.ok(took["review search"] < CALL_MS);
  const queue = M.reviewQueue(
    data,
    repos.map((/** @type {any} */ r) => r.slug),
  );
  assert.equal(queue.length, SIZES.reviews);
  const { rows } = M.reviewsView({
    width: 400,
    queue,
    reviewed: [],
    worktreeOf: () => undefined,
  });
  assert.equal(rows.length, SIZES.reviews);
});
