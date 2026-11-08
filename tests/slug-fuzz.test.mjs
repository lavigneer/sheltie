// slugOf on generated remote URLs: property checks with a seeded generator.
// Reproduce a failure with SLUG_FUZZ_SEED=<seed> npm test.
import assert from "node:assert/strict";
import { test } from "node:test";

const { slugOf } = await import("../src/git.js");

const SEED = Number(process.env.SLUG_FUZZ_SEED) || Date.now() % 2 ** 31;
const RUNS = 2000;

// mulberry32
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const gen = (r) => {
  const int = (n) => Math.floor(r() * n);
  const pick = (xs) => xs[int(xs.length)];
  const str = (alphabet, min, max) =>
    Array.from({ length: min + int(max - min + 1) }, () => pick(alphabet)).join(
      "",
    );
  const NAME = [
    ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.",
  ];
  const JUNK = [...NAME, ..."/:@ \t\n.git", "é", "\u{1F600}", "\0"];
  // GitHub-legal-ish names: never empty, never ending in ".git", not "." / "..".
  const name = () => {
    for (;;) {
      const s = str(NAME, 1, 12);
      if (!/\.git$/i.test(s) && s !== "." && s !== "..") return s;
    }
  };
  const ws = () => pick(["", "", " ", "\n", "\t", " \r\n"]);
  const githubUrl = (owner, repo) =>
    ws() +
    pick([
      `https://github.com/${owner}/${repo}`,
      `http://github.com/${owner}/${repo}`,
      `https://user@github.com/${owner}/${repo}`,
      `ssh://git@github.com/${owner}/${repo}`,
      `git@github.com:${owner}/${repo}`,
      `git://github.com/${owner}/${repo}`,
    ]) +
    pick(["", ".git", ".GIT"]) +
    pick(["", "", "/"]) +
    ws();
  const otherUrl = () =>
    pick([
      `https://${pick(["gitlab.com", "bitbucket.org", "example.com"])}/${name()}/${name()}.git`,
      `git@${pick(["gitlab.com", "git.example.org"])}:${name()}/${name()}`,
      str(JUNK, 0, 40),
      `https://github.com/${str(JUNK, 0, 15)}/${str(JUNK, 0, 15)}${str(JUNK, 0, 5)}`,
    ]);
  return { name, githubUrl, otherUrl, int };
};

const fail = (msg) => `${msg} (SLUG_FUZZ_SEED=${SEED})`;

const checkShape = (url, slug) => {
  if (slug === null) return;
  assert.equal(
    typeof slug,
    "string",
    fail(`non-string for ${JSON.stringify(url)}`),
  );
  const parts = slug.split("/");
  assert.equal(
    parts.length,
    2,
    fail(`bad slug ${JSON.stringify(slug)} for ${JSON.stringify(url)}`),
  );
  for (const p of parts) {
    assert.ok(
      p.length > 0,
      fail(`empty part in ${JSON.stringify(slug)} from ${JSON.stringify(url)}`),
    );
    assert.ok(
      !/\s/.test(p),
      fail(`whitespace in ${JSON.stringify(slug)} from ${JSON.stringify(url)}`),
    );
    assert.ok(
      !/\.git$/i.test(p),
      fail(`.git in ${JSON.stringify(slug)} from ${JSON.stringify(url)}`),
    );
  }
};

test("slugOf: a GitHub URL built from owner/repo gives that slug back", () => {
  const g = gen(rng(SEED));
  for (let i = 0; i < RUNS; i++) {
    const owner = g.name();
    const repo = g.name();
    const url = g.githubUrl(owner, repo);
    assert.equal(
      slugOf(url),
      `${owner}/${repo}`,
      fail(`for ${JSON.stringify(url)}`),
    );
  }
});

test("slugOf: any input gives null or a clean owner/repo", () => {
  const g = gen(rng(SEED ^ 0x9e3779b9));
  for (let i = 0; i < RUNS; i++) {
    const url = g.otherUrl();
    checkShape(url, slugOf(url));
  }
  for (const url of [
    null,
    undefined,
    "",
    " ",
    "github.com",
    "github.com/",
    "github.com/o/.git",
    "github.com/o/x.git.git",
    "https://github.com//",
  ]) {
    checkShape(url, slugOf(url));
  }
});
