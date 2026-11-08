// The GitHub issues tracker against the demo's fake GitHub.
import assert from "node:assert/strict";
import fs from "node:fs";
import { before, test } from "node:test";
import { demoCmd, prepare, sh, state, writeState } from "./demo.mjs";

let C, D, T;
before(async () => {
  prepare("github");
  const config = await import("../src/config.js");
  await config.configReady();
  C = config.C;
  D = {
    ...(await import("../src/git.js")),
    ...(await import("../src/prs.js")),
    ...(await import("../src/work.js")),
  };
  T = (await import("../src/tracker.js")).tracker();
});

test("the GitHub tracker is in use", () => {
  assert.equal(C.tracker, "github");
  assert.equal(T.name, "github");
});

test("list: open issues as tickets", async () => {
  const tickets = await T.list();
  const storage5 = tickets.find((t) => t.key === "acme/storage#5");
  assert.ok(storage5);
  assert.equal(storage5.label, "storage#5");
  assert.equal(storage5.ref, "issue-5");
  assert.equal(storage5.repo, "acme/storage");
  assert.equal(storage5.summary, "Stream large files");
});

test("view: an issue, null when there's none", async () => {
  assert.equal(
    (await T.view("acme/web-app#8")).summary,
    "Fix login redirect loop",
  );
  assert.equal(await T.view("acme/web-app#999"), null);
});

test("keysIn: branch part in its repo, #N, owner/repo#N", () => {
  assert.deepEqual(T.keysIn("issue-3-retry-backoff", "acme/Storage"), [
    "acme/storage#3",
  ]);
  assert.deepEqual(T.keysIn("me/issue-12", "a/b"), ["a/b#12"]);
  assert.deepEqual(T.keysIn("tissue-3", "a/b"), []);
  assert.deepEqual(T.keysIn("Fix it (#4), see x/y#9", "a/b").sort(), [
    "a/b#4",
    "x/y#9",
  ]);
  assert.deepEqual(T.keysIn("issue-3", null), []);
});

test("workFor: branches by name, PRs linked to the issue (also forks)", async () => {
  const keys = ["acme/storage#3", "acme/web-app#9", "acme/docs#2"];
  const work = await D.workFor(
    keys.map((key) => ({ key, tracker: T })),
    await D.localRepos(),
  );
  const storage3 = work.get("acme/storage#3");
  assert.ok(storage3.some((i) => i.worktree && i.pr?.number === 12));
  assert.ok(storage3.some((i) => i.branch === "issue-3-retry-backoff"));
  // PR #35 comes from a fork: found only because it closes #9.
  assert.ok(work.get("acme/web-app#9").some((i) => i.pr?.number === 35));
  assert.ok(
    work.get("acme/docs#2").some((i) => !i.repo.path && i.pr?.number === 56),
  );
});

test("suggestRepos: the issue's repo", async () => {
  const repos = await D.localRepos();
  const s = D.suggestRepos(await T.view("acme/storage#5"), repos, null, null);
  assert.deepEqual(
    s.map((x) => [x.repo.slug, x.why]),
    [["acme/storage", "issue's repo"]],
  );
  assert.equal(D.branchFor(await T.view("acme/storage#5")), "issue-5");
});

test("merging a PR that closes an issue closes it; Finish then has nothing to do", async () => {
  const storage = (await D.localRepos()).find((r) => r.name === "storage");
  const wt = await D.addWorktree(storage, "issue-5", { create: true });
  sh("git", ["commit", "--allow-empty", "-q", "-m", "#5: x"], wt);
  sh("git", ["push", "-q", "-u", "origin", "HEAD"], wt);
  const s = state();
  s.prs.push({
    repo: "acme/storage",
    number: 60,
    branch: "issue-5",
    title: "Stream large files",
    body: "Closes #5",
    draft: false,
    review: "APPROVED",
    checks: "SUCCESS",
    state: "OPEN",
    unresolved: 0,
  });
  writeState(s);
  await D.mergePr("acme/storage", 60);
  assert.equal((await T.view("acme/storage#5")).status, "Closed");
  assert.equal(await T.move("acme/storage#5", "done"), null);
});

test("Finish closes an issue merging didn't", async () => {
  const { runStep } = await import("../src/flow.js");
  const { ticketOfBranch } = await import("../src/tracker.js");
  const storage = (await D.localRepos()).find((r) => r.name === "storage");
  const wt = `${storage.path}/.worktrees/issue-3`;
  const pr = { ...(await D.prDetails("acme/storage", 12)), state: "MERGED" };
  // #12 says "Closes #3", but pretend GitHub didn't act on it.
  const note = await runStep(
    "finish",
    {
      path: wt,
      branch: "issue-3",
      handle: ticketOfBranch("issue-3", storage),
      repo: storage,
    },
    pr,
  );
  assert.match(note, /worktree removed · storage#3 closed/);
  assert.equal((await T.view("acme/storage#3")).status, "Closed");
  assert.ok(!fs.existsSync(wt));
  demoCmd("status");
});
