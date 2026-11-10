// Starting a review (start.js prepareReview): the PR checked out by `gh pr
// checkout` in <repo>/<worktreeDir>/review-<number>, a space named after the
// PR, agent.reviewTask as its prompt, and a second start reusing it all.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { after, before, test } from "node:test";

const { prepareReview, reviewSpaceName } = await import("../src/start.js");
const { reviewPath } = await import("../src/git.js");

const tmp = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/sheltie-review-`));
const env = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
Object.assign(process.env, env);
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const repo = { path: `${tmp}/app`, name: "app", slug: "acme/app" };
const review = {
  slug: "acme/app",
  number: 42,
  title: "Fix it",
  url: "https://github.com/acme/app/pull/42",
  author: "someone",
};
const calls = `${tmp}/gh-calls`;
let PATH;

before(() => {
  git(tmp, "init", "--quiet", "--bare", "-b", "main", "origin.git");
  git(tmp, "clone", "--quiet", `${tmp}/origin.git`, "app");
  git(repo.path, "commit", "--quiet", "--allow-empty", "-m", "init");
  git(repo.path, "push", "--quiet", "origin", "main");
  // A stand-in gh: `gh pr checkout N` puts the worktree on branch pr-N.
  fs.mkdirSync(`${tmp}/bin`);
  fs.writeFileSync(
    `${tmp}/bin/gh`,
    `#!/bin/sh\necho "$PWD $*" >> ${calls}\n[ "$1 $2" = "pr checkout" ] && exec git checkout -q -b "pr-$3"\nexit 1\n`,
    { mode: 0o755 },
  );
  PATH = process.env.PATH;
  process.env.PATH = `${tmp}/bin:${PATH}`;
});
after(() => {
  process.env.PATH = PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a review's worktree path and space name", () => {
  assert.equal(reviewPath(repo, 42), `${tmp}/app/.worktrees/review-42`);
  assert.equal(reviewSpaceName(review), "Review app#42");
});

test("prepareReview checks the PR out and fills agent.reviewTask", async () => {
  const s = await prepareReview(review, repo);
  const path = `${tmp}/app/.worktrees/review-42`;
  assert.deepEqual(s, {
    name: "Review app#42",
    folder: path,
    task: "/review-pr 42",
  });
  assert.equal(git(path, "branch", "--show-current"), "pr-42");
  assert.equal(fs.readFileSync(calls, "utf8"), `${path} pr checkout 42\n`);
  assert.equal(git(repo.path, "status", "--porcelain"), "");
});

test("starting the same review again reuses it, untold", async () => {
  const s = await prepareReview(review, repo);
  assert.equal(s.task, null);
  assert.equal(s.folder, `${tmp}/app/.worktrees/review-42`);
  assert.equal(fs.readFileSync(calls, "utf8").split("\n").length, 2);
});

test("a failed checkout leaves no worktree behind", async () => {
  await assert.rejects(prepareReview({ ...review, number: "x y" }, repo));
  assert.ok(!fs.existsSync(`${tmp}/app/.worktrees/review-x y`));
});

// Done reviewing (start.js finishReview / sweepReviews).
const { allReviewWorktrees, finishReview, sweepReviews } = await import(
  "../src/start.js"
);
const { live } = await import("herdr");

const reviewAt = async (number) => {
  await prepareReview({ ...review, number }, repo);
  return (await allReviewWorktrees([repo])).find((w) => w.number === number);
};
const branches = () => git(repo.path, "branch", "--format=%(refname:short)");

test("finishing a review removes its worktree, branch and space", async () => {
  const w = await reviewAt(43);
  assert.equal(w.branch, "pr-43");
  assert.equal(w.slug, "acme/app");
  live.spaces = [{ id: "s1", folder: w.path, tabs: [] }];
  await finishReview(repo, w);
  live.spaces = [];
  assert.ok(!fs.existsSync(w.path));
  assert.ok(!branches().split("\n").includes("pr-43"));
});

test("a worktree with uncommitted changes is refused, untouched", async () => {
  const w = await reviewAt(44);
  fs.writeFileSync(`${w.path}/notes.txt`, "wip");
  await assert.rejects(finishReview(repo, w), /uncommitted changes/);
  assert.ok(fs.existsSync(`${w.path}/notes.txt`));
  assert.ok(branches().split("\n").includes("pr-44"));
  fs.rmSync(`${w.path}/notes.txt`);
});

test("sweeping tears down merged and closed reviews, keeps open ones", async () => {
  await reviewAt(45);
  await reviewAt(46);
  const w44 = (await allReviewWorktrees([repo])).find((w) => w.number === 44);
  fs.writeFileSync(`${w44.path}/notes.txt`, "wip");
  const states = { 42: "OPEN", 44: "MERGED", 45: "MERGED", 46: "CLOSED" };
  const { kept, refused } = await sweepReviews(
    await allReviewWorktrees([repo]),
    [],
    async (_slug, n) => ({ state: states[n], title: `PR ${n}`, url: "u" }),
  );
  assert.deepEqual(kept.map((w) => w.number).sort(), [42, 44]);
  assert.deepEqual(
    refused.map((w) => [w.number, w.why]),
    [[44, "review-44 has uncommitted changes"]],
  );
  const left = (await allReviewWorktrees([repo])).map((w) => w.number).sort();
  assert.deepEqual(left, [42, 44]);
});

test("a queued review isn't looked up or swept", async () => {
  const { kept } = await sweepReviews(
    await allReviewWorktrees([repo]),
    [
      { slug: "ACME/app", number: 42 },
      { slug: "acme/app", number: 44 },
    ],
    async () => assert.fail("looked up"),
  );
  assert.deepEqual(kept, []);
});
