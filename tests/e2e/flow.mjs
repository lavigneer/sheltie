// The end-to-end scenarios, once per tracker: the mods load, a fresh ticket
// starts from the tickets popup, its repo's hub row opens a space of its own,
// and its whole flow runs from the Work sidebar's keys, through to Finish (on
// the way, the PR conflicts with main: Resolve conflicts). With `failures`, CI fails once (Fix CI)
// and Finish first refuses a worktree with uncommitted changes.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { Herdr, missingTools, waitFor } from "./herdr.mjs";

// t: { tracker, filter (typed in the popup), ref (for herdr-demo), repo,
//      worktree (relative to ws/), branch, task (RegExp the agent's screen
//      shows), ticketUrl (where its ticket opens), ticketDone(state),
//      readyWhen (the demo's workflow.readyWhen: "agent" checks that Ready
//      waits for the agent's pr=ready label) }
export function flow(t, { failures = false } = {}) {
  const missing = missingTools();
  if (missing.length) {
    test(`e2e (${t.tracker})`, () => {
      assert.fail(`needs ${missing.join(", ")} on PATH`);
    });
    return;
  }

  const h = new Herdr(t.tracker);
  const repo = () => path.join(h.demo, "ws", t.repo);
  const worktree = () => path.join(h.demo, "ws", t.worktree);
  let broken = null; // the first failed scenario: the later ones depend on it

  // A scenario: skipped after an earlier one failed; on failure, saves a
  // screenshot, the log and the state (see Herdr.saveFailure).
  const scenario = (name, body) =>
    test(`${t.tracker}: ${name}`, { timeout: 180_000 }, async (ctx) => {
      if (broken) return ctx.skip(`"${broken}" failed`);
      try {
        await body();
      } catch (e) {
        broken = name;
        const saved = await h.saveFailure(name).catch(() => null);
        if (saved) e.message += `\n  (screenshot, log and state: ${saved}*)`;
        throw e;
      }
    });

  before(() => h.start(), { timeout: 120_000 });
  after(() => h.stop(), { timeout: 60_000 });

  scenario("the mods load", async () => {
    for (const mod of ["tickets", "work", "projects"])
      await h.sh("herdr-app", ["check", path.join(h.home, "mods", mod)]);
    await waitFor("the sidebar's first scan", async () => (await h.report()).loaded);
    await h.assertNoErrors("after start");
  });

  scenario("start a fresh ticket from the popup, by keyboard", async () => {
    await h.key("ctrl+shift+j");
    await waitFor("the tickets popup", async () => (await h.status()).overlays.includes("tickets"));
    await h.assertNoErrors("after opening the tickets popup");
    await h.type(t.filter);
    // Enter starts it. Pressed before the popup knows the ticket's work, Enter
    // opens the ticket's screen instead, whose first row is then "Start in
    // <repo>": so press it again while the popup is still open.
    let pressed = 0;
    await waitFor(
      "the ticket's worktree",
      async () => {
        if ((await h.worktrees(repo())).includes(worktree())) return true;
        if (Date.now() - pressed > 1_500 && (await h.status()).overlays.includes("tickets")) {
          pressed = Date.now();
          await h.key("Return");
        }
        return false;
      },
      { timeout: 30_000 },
    );
    const space = await waitFor("its space", () => h.spaceAt(worktree()));
    assert.equal(space.active, true, "its space is shown");
    const terminal = space.tabs[0].terminals[0].terminal;
    await waitFor("the agent to get its task", async () => t.task.test(await h.screen(terminal)));
    assert.equal((await h.status()).overlays.includes("tickets"), false, "the popup closed");
    // Agent steps go to that terminal (not to a new agent).
    await h.waitRow("its agent", worktree(), (r) => r.agent === terminal);
    t.started?.(h.state());
    await h.assertNoErrors("after starting the ticket");
  });

  scenario("open the row's ticket, and no PR yet, by keyboard", async () => {
    const r = await h.waitRow("its ticket's URL", worktree(), (r) => r.selected && r.ticketUrl);
    assert.equal(r.ticketUrl, t.ticketUrl);
    assert.equal(r.pr, null, "no PR yet");
    await h.key("alt+shift+p"); // no PR: nothing opens, nothing errors
    await h.key("alt+shift+t");
    await waitFor("the ticket to open", () => h.opened().includes(t.ticketUrl));
    assert.deepEqual(h.opened(), [t.ticketUrl], "only the ticket opened");
    await h.assertNoErrors("after opening the ticket");
  });

  scenario("the repo's hub row: above the worktree, a space of its own", async () => {
    const own = await h.spaceAt(worktree());
    const { rows } = await h.report();
    const hubAt = rows.findIndex((r) => r.path === repo());
    const at = rows.findIndex((r) => r.path === worktree());
    assert.ok(hubAt >= 0, "a row for the repo's main checkout");
    const hub = rows[hubAt];
    assert.equal(hub.hub, true, "marked as the hub");
    assert.equal(rows[at].hub, false, "the worktree isn't a hub");
    assert.ok(hubAt < at, "the hub comes first");
    assert.ok(
      rows.slice(hubAt + 1, at).every((r) => !r.hub),
      "the worktree's group is the hub's",
    );
    assert.deepEqual(hub.steps, [], "no steps");
    assert.equal(hub.pr, null, "no PR");
    assert.notEqual(hub.space, own.id, "not the worktree's space");
    assert.equal(rows[at].selected, true, "the focused worktree's row is selected");

    // Up to the hub; nothing to open in the browser; open its space.
    for (let i = hubAt; i < at; i++) await h.key("alt+shift+Up");
    await h.waitRow("the hub selected", repo(), (r) => r.selected);
    await h.key("alt+shift+p", "alt+shift+t");
    await h.key("alt+shift+o");
    const space = await waitFor("the hub's space", () => h.spaceAt(repo()));
    assert.notEqual(space.id, own.id, "a space of its own");
    await h.waitRow("the hub's space", repo(), (r) => r.space === space.id && r.selected);
    assert.equal((await h.row(worktree())).space, own.id, "the worktree keeps its space");
    assert.deepEqual(h.opened(), [t.ticketUrl], "nothing opened for the hub");

    // Back to the worktree's space, for the rest of the flow.
    for (let i = hubAt; i < at; i++) await h.key("alt+shift+Down");
    await h.waitRow("the worktree selected", worktree(), (r) => r.selected);
    await h.key("alt+shift+o");
    await waitFor("its space shown", async () => (await h.spaceAt(worktree()))?.active);
    await h.waitRow("its row selected", worktree(), (r) => r.selected && r.space === own.id);
    await h.assertNoErrors("after opening the hub");
  });

  scenario("the whole flow, from the sidebar's keys", async () => {
    const space = await h.spaceAt(worktree());
    const terminal = space.tabs[0].terminals[0].terminal;
    // The agent got `cmd` and is done with it: it prints `done` after
    // pushing and updating the demo's state. Counts lines, as a command can
    // come more than once.
    const seen = new Map();
    const sent = async (cmd, done) => {
      const n = (seen.get(done) ?? 0) + 1;
      await waitFor(`the agent to get ${cmd} and finish it`, async () => {
        const screen = await h.screen(terminal);
        return screen.includes(cmd) && screen.split(done).length - 1 >= n;
      });
      seen.set(done, n);
    };

    // Draft PR -> the agent opens a draft PR; CI runs and passes.
    await h.step(worktree(), "draft-pr");
    await sent("/draft-pr", "CI is running; it takes");
    assert.equal(h.pr(t.branch)?.draft, true, "a draft PR");
    await h.waitRow(
      "CI passed, Ready offered",
      worktree(),
      // The demo's state too: the sidebar may not have seen the latest run start.
      (r) =>
        h.pr(t.branch)?.checks === "SUCCESS" &&
        r.pr?.checks === "passed" &&
        r.steps.some((s) => s.id === "ready"),
    );
    if (t.readyWhen === "agent") {
      // Ready is there because the agent said pr=ready: without it, it goes.
      assert.equal((await h.row(worktree())).agentDone, true, "the agent said pr=ready");
      await h.sh("hc", ["label", terminal, "pr="]);
      const r = await h.waitRow("Ready hidden without pr=ready", worktree(), (r) => !r.agentDone);
      assert.equal(r.steps.some((s) => s.id === "ready"), false, "no Ready");
      await h.sh("hc", ["label", terminal, "pr=ready"]);
      await h.waitRow("Ready back with pr=ready", worktree(), (r) =>
        r.steps.some((s) => s.id === "ready"),
      );
    }
    await h.assertNoErrors("after Draft PR");

    // Its PR, in the browser.
    const prUrl = `https://github.com/${h.pr(t.branch).repo}/pull/${h.pr(t.branch).number}`;
    const withPr = await h.waitRow("the PR's URL", worktree(), (r) => r.selected && r.prUrl);
    assert.equal(withPr.prUrl, prUrl);
    await h.key("alt+shift+p");
    await waitFor("the PR to open", () => h.opened().at(-1) === prUrl);
    await h.assertNoErrors("after opening the PR");

    // Main moves on and the PR conflicts with it: GitHub runs no CI, so the
    // row offers only Resolve conflicts (no Ready), until the agent has
    // merged main in and CI has passed again.
    await h.demoCmd("conflict", t.ref);
    const c = await h.waitRow(
      "conflicts, Resolve conflicts offered",
      worktree(),
      (r) => r.pr?.mergeable === "CONFLICTING",
    );
    assert.equal(c.pr.checks, null, "no checks");
    assert.match(c.pr.label, /\bconflicts\b/, "labelled conflicts");
    assert.deepEqual(
      c.steps.map((s) => s.id),
      ["resolve-conflicts"],
      "only Resolve conflicts",
    );
    await h.step(worktree(), "resolve-conflicts");
    await sent("/resolve-conflicts", "Pushed the merge; CI is running");
    assert.equal(h.pr(t.branch).mergeable, "MERGEABLE", "conflicts resolved");
    const resolved = await h.waitRow(
      "CI passed after resolving, Ready back",
      worktree(),
      (r) =>
        h.pr(t.branch)?.checks === "SUCCESS" &&
        r.pr?.mergeable === "MERGEABLE" &&
        r.pr?.checks === "passed" &&
        r.steps.some((s) => s.id === "ready"),
    );
    assert.doesNotMatch(resolved.pr.label, /conflicts/);
    await h.assertNoErrors("after Resolve conflicts");

    // Review comments -> Address comments.
    await h.demoCmd("comment", t.ref);
    if (failures) await h.demoCmd("fail-ci", t.ref); // the next CI run fails
    const r = await h.waitRow("2 comments", worktree(), (r) => r.pr?.unresolved === 2);
    assert.deepEqual(
      r.steps.map((s) => s.label),
      ["Address 2 comments"],
      "only Address comments (not Ready) while comments are unresolved",
    );
    await h.step(worktree(), "address-comments");
    await sent("/address-comments", "Addressed the comments");
    assert.equal(h.pr(t.branch).unresolved, 0, "comments resolved");
    await h.assertNoErrors("after Address comments");

    if (failures) {
      // CI fails -> Fix CI, and CI passes again.
      const f = await h.waitRow(
        "CI failed, Fix CI offered",
        worktree(),
        (r) => r.pr?.checks === "failed",
      );
      assert.deepEqual(
        f.steps.map((s) => s.id),
        ["fix-ci"],
      );
      await h.step(worktree(), "fix-ci");
      await sent("/fix-ci", "Pushed a fix; CI is running again");
      await h.assertNoErrors("after Fix CI");
    }

    // Ready -> ready for review, auto-merge on (a review is required).
    await h.waitRow(
      "CI passed, Ready offered",
      worktree(),
      // The demo's state too: the sidebar may not have seen the latest run start.
      (r) =>
        h.pr(t.branch)?.checks === "SUCCESS" &&
        r.pr?.checks === "passed" &&
        r.steps.some((s) => s.id === "ready"),
    );
    const ready = await h.step(worktree(), "ready");
    assert.equal(ready.last.phase, "done", ready.last.text);
    const pr = h.pr(t.branch);
    assert.equal(pr.draft, false, "ready for review");
    assert.equal(pr.autoMerge, true, "auto-merge on");
    assert.equal(pr.state, "OPEN", "not merged before approval");
    t.inReview?.(h.state());
    await h.assertNoErrors("after Ready");

    // Approved -> auto-merge merges it -> Finish.
    await h.demoCmd("approve", t.ref);
    await h.waitRow(
      "merged, Finish offered",
      worktree(),
      (r) => r.pr?.state === "MERGED" && r.steps.some((s) => s.id === "finish"),
    );
    assert.equal(h.pr(t.branch).state, "MERGED");

    if (failures) {
      // Finish refuses while the worktree has uncommitted changes.
      fs.appendFileSync(path.join(worktree(), "README.md"), "\nnot committed\n");
      const refused = await h.step(worktree(), "finish");
      assert.equal(refused.last?.phase, "failed", "Finish refused");
      assert.match(refused.last.text, /uncommitted changes/);
      assert.ok((await h.worktrees(repo())).includes(worktree()), "worktree kept");
      assert.ok(await h.spaceAt(worktree()), "space kept");
      await h.sh("git", ["-C", worktree(), "checkout", "--", "README.md"]);
    }

    const done = await h.step(worktree(), "finish");
    if (!done.gone) assert.equal(done.last.phase, "done", done.last.text);
    await waitFor("its row to go", async () => !(await h.row(worktree())));
    assert.equal((await h.worktrees(repo())).includes(worktree()), false, "worktree removed");
    assert.equal(fs.existsSync(worktree()), false, "worktree folder removed");
    assert.equal(await h.branchExists(repo(), t.branch), false, "local branch deleted");
    await waitFor("its space to close", async () => !(await h.spaceAt(worktree())));
    await waitFor("the ticket to be done", () => t.ticketDone(h.state()));
    await h.assertNoErrors("after Finish");
  });
}
