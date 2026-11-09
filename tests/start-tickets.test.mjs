// startTickets and work.start against the demo's fake GitHub: skipped,
// cloned, started, a worktree reused untold, and a request file's result.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { prepare } from "./demo.mjs";

let S, W, G, T;
before(async () => {
  prepare("github");
  await (await import("../src/config.js")).configReady();
  S = await import("../src/start.js");
  W = await import("../src/work.js");
  G = await import("../src/git.js");
  T = (await import("../src/tracker.js")).tracker();
});

const ticket = async (key) => ({ ...(await T.view(key)), tracker: T });

test("startTickets: skips open work, clones, starts in the best repo", async () => {
  const repos = await G.localRepos();
  const tickets = await Promise.all(
    ["acme/storage#5", "acme/storage#3", "acme/platform#1"].map(ticket),
  );
  const nowhere = { ...tickets[0], key: "x/y#1", label: "y#1", repo: null };
  const work = await W.workFor(tickets, repos);
  const steps = [];
  const { results, spaces } = await S.startTickets(
    [...tickets, nowhere].map((t) => ({ ticket: t, repo: null })),
    { repos, work, onStep: (m) => steps.push(m) },
  );
  assert.deepEqual(
    results.map((r) => [r.ticket, r.status, r.repo ?? r.why]),
    [
      ["acme/storage#5", "started", "acme/storage"],
      ["acme/storage#3", "skipped", "already has open work"],
      ["acme/platform#1", "started", "acme/platform"],
      ["x/y#1", "failed", "no repo for it"],
    ],
  );
  assert.ok(steps.includes("Cloning acme/platform…"));
  assert.ok(repos.some((r) => r.slug === "acme/platform" && r.path));
  assert.equal(spaces.length, 2);
  for (const s of spaces) {
    assert.ok(fs.existsSync(s.folder));
    assert.match(s.task, /^Work on/);
  }
});

test("startTickets: an explicit repo; a closed-out worktree is reused untold", async () => {
  const repos = await G.localRepos();
  const t = await ticket("acme/storage#5");
  const storage = repos.find((r) => r.slug === "acme/storage");
  const folder = path.join(storage.path, ".worktrees/issue-5");
  const work = new Map([
    [
      t.key,
      [
        {
          repo: storage,
          branch: "issue-5",
          worktree: folder,
          pr: { state: "MERGED" },
        },
      ],
    ],
  ]);
  const { results, spaces } = await S.startTickets(
    [{ ticket: t, repo: W.findRepo("acme/storage", repos) }],
    { repos, work },
  );
  assert.equal(results[0].status, "started");
  assert.equal(spaces[0].folder, folder);
  assert.equal(spaces[0].task, null);
});

test("work.start: a request file gets its result", async () => {
  const dir = path.join(process.env.HERDR_APP_HOME, "work-start");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "r1.json"),
    JSON.stringify({ tickets: ["storage#5", "acme/web-app#999"] }),
  );
  await S.drainRequests(dir);
  const out = JSON.parse(
    fs.readFileSync(path.join(dir, "r1.result.json"), "utf8"),
  );
  assert.deepEqual(
    out.results.map((r) => [r.ticket, r.status, r.why]),
    [
      ["acme/web-app#999", "failed", "no such ticket"],
      ["acme/storage#5", "skipped", "already has open work"],
    ],
  );
});
