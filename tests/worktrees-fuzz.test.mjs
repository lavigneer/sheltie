// Property tests: parseWorktrees on generated `git worktree list --porcelain`
// output. Seeded so a failure can be replayed with FUZZ_SEED=<seed>.
import assert from "node:assert/strict";
import { test } from "node:test";

const { parseWorktrees } = await import("../src/git.js");

// mulberry32: a small seeded PRNG.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const repo = "/ws/my repo";
const chars = "abcXYZ019-_./ é";

function gen(rand) {
  const int = (n) => Math.floor(rand() * n);
  const pick = (xs) => xs[int(xs.length)];
  const word = () =>
    Array.from({ length: 1 + int(8) }, () => pick([...chars]))
      .join("")
      .trim() || "w";
  const entries = [];
  const paths = new Set();
  const withMain = rand() < 0.8;
  const count = int(6) + (withMain ? 1 : 0);
  for (let i = 0; i < count; i++) {
    const isMain = withMain && i === 0;
    let path = repo;
    if (!isMain) {
      do
        path = `${repo}/${pick([".worktrees", ".claude/worktrees", "../x"])}/${word()}`;
      while (paths.has(path));
    }
    paths.add(path);
    const kind =
      isMain && rand() < 0.15 ? "bare" : pick(["branch", "detached"]);
    const branch = kind === "branch" ? `${word()}/${word()}` : null;
    const lines = [`worktree ${path}`];
    if (kind !== "bare") lines.push(`HEAD ${int(1e9).toString(16)}`);
    if (kind === "bare") lines.push("bare");
    else if (branch) lines.push(`branch refs/heads/${branch}`);
    else lines.push("detached");
    if (rand() < 0.3) lines.push(rand() < 0.5 ? "locked" : `locked ${word()}`);
    if (rand() < 0.3)
      lines.push(
        rand() < 0.5 ? "prunable" : `prunable gitdir file points to ${word()}`,
      );
    entries.push({ path, branch, isMain, lines });
  }
  let out = entries.map((e) => `${e.lines.join("\n")}\n`).join("\n");
  if (rand() < 0.5)
    out = out.replace(/\n$/, ""); // missing trailing blank/newline
  else if (out) out += "\n";
  return { entries, out };
}

test("parseWorktrees: properties hold on generated porcelain output", () => {
  const seed = Number(process.env.FUZZ_SEED) || Date.now() >>> 0;
  const rand = rng(seed);
  for (let i = 0; i < 500; i++) {
    const { entries, out } = gen(rand);
    const at = `seed ${seed}, case ${i}:\n${out}`;
    let got;
    assert.doesNotThrow(() => {
      got = parseWorktrees(out, repo);
    }, at);
    const main = entries.find((e) => e.isMain);
    assert.equal(got.mainBranch, main?.branch ?? null, at);
    const linked = entries.filter((e) => !e.isMain);
    assert.deepEqual(
      got.linked,
      linked.map((e) => ({ path: e.path, branch: e.branch })),
      at,
    );
    for (const w of got.linked) {
      assert.notEqual(w.path, repo, at);
      assert.equal(got.linked.filter((x) => x.path === w.path).length, 1, at);
    }
  }
});

test("parseWorktrees: never throws on arbitrary text", () => {
  const seed = Number(process.env.FUZZ_SEED) || Date.now() >>> 0;
  const rand = rng(seed);
  const bits = [
    "worktree ",
    "branch refs/heads/",
    "detached",
    "bare",
    "\n",
    "\n\n",
    "x",
    " ",
    "HEAD 1",
  ];
  for (let i = 0; i < 500; i++) {
    const s = Array.from(
      { length: Math.floor(rand() * 12) },
      () => bits[Math.floor(rand() * bits.length)],
    ).join("");
    assert.doesNotThrow(
      () => parseWorktrees(s, repo),
      `seed ${seed}, case ${i}: ${JSON.stringify(s)}`,
    );
  }
  for (const v of [undefined, null, ""])
    assert.doesNotThrow(() => parseWorktrees(v, repo));
});
