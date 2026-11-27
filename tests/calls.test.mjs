// Program calls counted per mod (lib.js: callCounts, callsSince): every process
// started, and every call answered or refused as rate limited. This file has
// its own process, so no other test's calls are in the counts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { C } = await import("../src/config.js");
const { callCounts, callsSince, tool } = await import("../src/lib.js");

// A program that prints ok, or answers like GitHub's rate limit when told to.
function fakeProgram(dir, name, limitArg) {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh
if [ "$1" = "${limitArg}" ]; then echo "API rate limit exceeded" >&2; exit 1; fi
echo ok`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

test("callsSince: counts the processes started and the rate limits since a mark", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sheltie-calls-"));
  const { git: gitWas, gh: ghWas } = C.programs;
  C.programs.git = fakeProgram(dir, "git", "never");
  C.programs.gh = fakeProgram(dir, "gh", "limit");
  try {
    const before = callCounts();
    await tool("git", ["status"]);
    await tool("git", ["status"]);
    // The first gh call is answered "rate limited"; the second is refused
    // during the backoff without starting a process.
    assert.equal((await tool("gh", ["limit"])).code, 1);
    assert.equal((await tool("gh", ["ok"])).code, 1);
    assert.deepEqual(callsSince(before), {
      spawns: { git: 2, gh: 1 },
      rateLimited: 2,
    });
    // A mark taken now has nothing in it yet.
    assert.deepEqual(callsSince(callCounts()), { spawns: {}, rateLimited: 0 });
  } finally {
    C.programs.git = gitWas;
    C.programs.gh = ghWas;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
