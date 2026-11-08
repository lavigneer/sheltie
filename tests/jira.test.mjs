// The Jira tracker and the shared data/workflow code against the demo's fake
// Jira and GitHub.
import assert from "node:assert/strict";
import fs from "node:fs";
import { before, test } from "node:test";
import { demoCmd, prepare, sh, state, writeState } from "./demo.mjs";

let C, D, T;
before(async () => {
  prepare("jira");
  ({ C } = await import("../src/config.js"));
  await (await import("../src/config.js")).configReady();
  D = await import("../src/data.js");
  T = (await import("../src/tracker.js")).tracker();
});

const tryErr = async (f) => {
  try {
    await f();
    return null;
  } catch (e) {
    return e.message;
  }
};

test("settings come from the app home's sheltie.json", () => {
  assert.equal(C.tracker, "jira");
  assert.equal(C.branch, "me/{ref}");
  assert.equal(C.problem, null);
  assert.match(C.programs.gh, /demo\/bin\/gh$/);
  // Defaults fill in what the file doesn't set.
  assert.equal(C.workflow.autoMerge, "when-reviews-required");
});

test("view: a ticket, null for an unknown key, throws when Jira is down", async () => {
  assert.equal((await T.view("WEB-101")).summary, "Retry Storage uploads with backoff");
  assert.equal(await T.view("UTF-8"), null);
  fs.writeFileSync(`${process.env.HERDR_DEMO}/jira-down`, "");
  assert.match((await tryErr(() => T.view("WEB-101"))) ?? "", /connection refused/);
  fs.rmSync(`${process.env.HERDR_DEMO}/jira-down`);
});

test("list and keysIn", async () => {
  const keys = (await T.list()).map((t) => t.key);
  assert.ok(keys.includes("WEB-105") && keys.includes("PLAT-9"));
  assert.deepEqual(T.keysIn("me/web-101-retry"), ["WEB-101"]);
});

test("move: transitions per step, null when there's nothing to do", async () => {
  assert.equal(await T.move("WEB-102", "review"), "WEB-102 → In Review");
  assert.equal(
    state().tickets.find((t) => t.key === "WEB-102").status,
    "In Review",
  );
  assert.equal(await T.move("WEB-102", "start", "In Progress"), null);
  assert.match((await tryErr(() => T.move("NOPE-1", "done"))) ?? "", /does not exist/);
});

test("PR details, review threads, check results", async () => {
  const p12 = await D.prDetails("acme/storage", "me/WEB-101");
  assert.equal(p12.number, 12);
  assert.match(p12.head, /^[0-9a-f]{40}$/);
  assert.equal(await D.prDetails("acme/storage", "me/nope"), null);
  assert.equal((await D.prDetails("acme/web-app", 34)).checks, "failed");
  assert.equal(await D.unresolvedThreads("acme/web-app", 34), 2);
});

test("workFor: worktrees, branches and PRs per ticket, fork PRs included", async () => {
  const work = await D.workFor(["WEB-101", "WEB-103", "WEB-104"], await D.localRepos());
  const w101 = work.get("WEB-101");
  assert.ok(w101.some((i) => i.worktree && i.pr?.number === 12));
  assert.ok(w101.some((i) => i.branch === "me/WEB-101-retry-backoff"));
  assert.ok(work.get("WEB-103").some((i) => i.pr?.number === 35));
  assert.ok(work.get("WEB-104").some((i) => !i.repo.path && i.pr?.number === 56));
});

test("suggestRepos: component rules win over project rules", async () => {
  const repos = await D.localRepos();
  const t105 = await T.view("WEB-105");
  const s = D.suggestRepos(t105, repos, null, null);
  assert.deepEqual(
    s.map((x) => [x.repo.slug, x.why]),
    [["acme/storage", "component Storage"]],
  );
});

test("addWorktree: local, origin, PR head, create; never a look-alike branch", async () => {
  const web = (await D.localRepos()).find((r) => r.name === "web-app");
  assert.match(
    (await tryErr(() => D.addWorktree(web, "me/GONE-1"))) ?? "",
    /isn't a local branch or on origin/,
  );
  assert.equal(sh("git", ["branch", "--list", "me/GONE-1"], web.path).trim(), "");
  const fork = await D.addWorktree(web, "contributor/WEB-103-fix", { pr: 35 });
  assert.equal(sh("git", ["branch", "--show-current"], fork).trim(), "contributor/WEB-103-fix");
  assert.match(
    (await tryErr(() => D.addWorktree(web, "someone/x", { pr: 99 }))) ?? "",
    /PR #99's head couldn't be fetched/,
  );
  assert.ok(fs.existsSync(await D.addWorktree(web, "me/WEB-999", { create: true })));
});

test("ready, auto-merge on approval, finish refuses unpushed work", async () => {
  const web = (await D.localRepos()).find((r) => r.name === "web-app");
  const wt = `${web.path}/.claude/worktrees/WEB-103`;
  sh("git", ["commit", "--allow-empty", "-q", "-m", "WEB-103: x"], wt);
  sh("git", ["push", "-q", "-u", "origin", "HEAD"], wt);
  const s = state();
  s.prs.push({
    repo: "acme/web-app", number: 36, branch: "me/WEB-103", title: "WEB-103: x",
    body: "", draft: true, review: "REVIEW_REQUIRED", checks: "SUCCESS", state: "OPEN", unresolved: 0,
  });
  writeState(s);
  const { runStep } = await import("../src/flow.js");
  const w = { path: wt, branch: "me/WEB-103", key: "WEB-103", repo: web };
  let pr = await D.prDetails("acme/web-app", 36);
  assert.match(await runStep("ready", w, pr), /auto-merge on approval · WEB-103 → In Review/);
  pr = await D.prDetails("acme/web-app", 36);
  assert.ok(!pr.draft && pr.autoMerge && pr.state === "OPEN");
  demoCmd("approve", "acme/web-app#36");
  pr = await D.prDetails("acme/web-app", 36);
  assert.equal(pr.state, "MERGED");

  fs.writeFileSync(`${wt}/x.txt`, "dirty");
  assert.match((await tryErr(() => runStep("finish", w, pr))) ?? "", /uncommitted changes/);
  fs.rmSync(`${wt}/x.txt`);
  sh("git", ["commit", "--allow-empty", "-q", "-m", "local only"], wt);
  assert.match((await tryErr(() => runStep("finish", w, pr))) ?? "", /aren't in the PR/);
  sh("git", ["reset", "-q", "--hard", "HEAD~1"], wt);
  assert.match(await runStep("finish", w, pr), /worktree removed · WEB-103 → Resolved/);
  assert.ok(!fs.existsSync(wt));
});

test("a conflicting PR: mergeable CONFLICTING, no checks, no auto-merge", async () => {
  const { nextSteps } = await import("../src/flow.js");
  let pr = await D.prDetails("acme/docs", 56);
  assert.equal(pr.mergeable, "MERGEABLE");
  assert.equal(pr.checks, "passed");
  demoCmd("conflict", "acme/docs#56");
  pr = await D.prDetails("acme/docs", 56);
  assert.equal(pr.mergeable, "CONFLICTING");
  assert.equal(pr.checks, null, "GitHub runs no CI on it");
  assert.deepEqual(D.prLabel(pr), { text: "#56 conflicts", tone: "bad" });
  assert.deepEqual(nextSteps({ ...pr, unresolved: 0 }).map((s) => s.id), ["resolve-conflicts"]);
  // Approved with auto-merge on: still doesn't merge.
  const s = state();
  Object.assign(s.prs.find((p) => p.repo === "acme/docs" && p.number === 56), {
    review: "APPROVED", autoMerge: true, checks: "SUCCESS",
  });
  writeState(s);
  assert.equal((await D.prDetails("acme/docs", 56)).state, "OPEN");
});
