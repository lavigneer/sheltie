// Property tests over random inputs: branch names round-trip to ticket keys,
// ad-hoc branches are valid git branch names, worktrees stay in worktreeDir.
// Each test prints its seed on failure; rerun with SEED=<n> to reproduce.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, sep } from "node:path";
import { test } from "node:test";

const { C, DEFAULTS, merge } = await import("../src/config.js");
const { adhocBranch, branchFor, worktreePath } = await import("../src/git.js");
const github = await import("../src/tracker-github.js");
const jira = await import("../src/tracker-jira.js");
const { ticketOfBranch } = await import("../src/tracker.js");

// mulberry32: a small seeded generator.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = (xs) => xs[int(0, xs.length - 1)];
  const str = (chars, lo, hi) =>
    Array.from({ length: int(lo, hi) }, () => pick(chars)).join("");
  return { int, pick, str };
}

const RUNS = 300;
// Runs `body(r, i)` RUNS times; a failure names the seed that reproduces it.
function property(name, body) {
  test(name, () => {
    const seed = Number(process.env.SEED ?? Date.now() % 2 ** 31);
    const r = rng(seed);
    for (let i = 0; i < RUNS; i++) {
      try {
        body(r, i);
      } catch (e) {
        e.message = `${e.message}\n(seed ${seed}, run ${i}: SEED=${seed} npm test)`;
        throw e;
      }
    }
  });
}

const lower = "abcdefghijklmnopqrstuvwxyz";
const upper = lower.toUpperCase();
const digits = "0123456789";
// Branch template parts: words split by "/" or "-" (as real templates are).
const word = (r) => r.str(lower, 1, 6);
const template = (r) => {
  const pre = Array.from(
    { length: r.int(0, 2) },
    () => word(r) + r.pick(["/", "-"]),
  );
  const post = r.int(0, 1) ? `-${word(r)}` : "";
  return `${pre.join("")}{ref}${post}`;
};
const settings = (over) => merge(JSON.parse(JSON.stringify(DEFAULTS)), over);

property("github: a ticket's branch gives back its key", (r) => {
  const slug = `${r.str(lower + digits, 1, 8)}/${r.str(`${lower + digits}-.`, 1, 10)}`;
  const s = settings({
    tracker: "github",
    branch: template(r),
    github: { ref: r.pick(["issue-{number}", "gh{number}", "{number}-x"]) },
  });
  const tracker = github.create(s);
  const repo = { slug, path: "/r", settings: s, tracker };
  const number = r.int(1, 99999);
  const ticket = {
    key: `${slug}#${number}`,
    ref: s.github.ref.replace("{number}", number),
  };
  const branch = branchFor(ticket, repo);
  assert.equal(ticketOfBranch(branch, repo)?.key, ticket.key, branch);
});

property("jira: a ticket's branch gives back its key", (r) => {
  const s = settings({ tracker: "jira", branch: template(r) });
  const repo = {
    slug: "o/r",
    path: "/r",
    settings: s,
    tracker: jira.create(s),
  };
  const key = `${r.pick(upper)}${r.str(upper + digits, 1, 5)}-${r.int(1, 99999)}`;
  const branch = branchFor({ key, ref: key }, repo);
  assert.equal(ticketOfBranch(branch, repo)?.key, key, branch);
});

// Any characters, weighted toward the ones git and paths care about.
const nasty = (r) =>
  r.str([..."aZ09 -_./\\~^:?*[@{}#\t\n", "..", "é", "🐑", "\u0000"], 0, 30);

property("adhocBranch: a valid git branch name or null", (r, i) => {
  const s = settings({
    branch: r.pick(["{ref}", "me/{ref}", "{ref}-wip", "a.b/{key}"]),
  });
  const branch = adhocBranch(nasty(r), { settings: s });
  if (branch === null || i % 10) return; // git is slow: check every tenth
  execFileSync("git", ["check-ref-format", "--branch", branch], {
    stdio: "ignore",
  });
});

property("worktreePath: always under <repo>/<worktreeDir>", (r) => {
  const repo = { path: "/home/me/src/app" };
  const dir = resolve(repo.path, C.worktreeDir);
  const branch = nasty(r);
  let path;
  try {
    path = worktreePath(repo, branch);
  } catch {
    return; // refusing is fine; escaping isn't
  }
  assert.ok(resolve(path).startsWith(dir + sep), `${branch} -> ${path}`);
  assert.notEqual(resolve(path), dir);
});
