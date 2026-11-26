// Small shared helpers.
import assert from "node:assert/strict";
import { test } from "node:test";

const { cycle } = await import("../src/lib.js");

test("cycle: moves through n items and wraps both ways", () => {
  assert.equal(cycle(3, 0, 1), 1);
  assert.equal(cycle(3, 2, 1), 0);
  assert.equal(cycle(3, 0, -1), 2);
  assert.equal(cycle(1, 0, 1), 0);
});

// Runs before the rate-limit test below: its backoff holds every gh call in this file.
test("tool: an urgent gh call takes the next slot, ahead of queued lookups", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { C } = await import("../src/config.js");
  const { tool } = await import("../src/lib.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sheltie-gh-"));
  const log = path.join(dir, "log");
  const gh = path.join(dir, "gh");
  fs.writeFileSync(
    gh,
    `#!/bin/sh\necho "start $1" >> ${log}\nsleep 0.1\necho ok`,
  );
  fs.chmodSync(gh, 0o755);
  const was = C.programs.gh;
  C.programs.gh = gh;
  try {
    // Two running, four lookups queued, then a click's call.
    const lookups = ["q1", "q2", "q3", "q4", "q5", "q6"].map((x) =>
      tool("gh", [x]),
    );
    await Promise.all([...lookups, tool("gh", ["click"], { urgent: true })]);
    const started = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.ok(started.indexOf("start click") < started.indexOf("start q5"));
    assert.ok(started.indexOf("start click") < started.indexOf("start q6"));
  } finally {
    C.programs.gh = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tool: gh runs two at a time and backs off after a rate limit", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { C } = await import("../src/config.js");
  const { tool } = await import("../src/lib.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sheltie-gh-"));
  const log = path.join(dir, "log");
  const gh = path.join(dir, "gh");
  // Logs start/end; "limit" answers like GitHub's rate limit.
  fs.writeFileSync(
    gh,
    `#!/bin/sh
echo "start $1" >> ${log}
sleep 0.2
echo "end $1" >> ${log}
if [ "$1" = limit ]; then echo "API rate limit exceeded" >&2; exit 1; fi
echo ok`,
  );
  fs.chmodSync(gh, 0o755);
  const was = C.programs.gh;
  C.programs.gh = gh;
  try {
    await Promise.all(["a", "b", "c", "d"].map((x) => tool("gh", [x])));
    let running = 0;
    let most = 0;
    for (const line of fs.readFileSync(log, "utf8").trim().split("\n")) {
      running += line.startsWith("start") ? 1 : -1;
      most = Math.max(most, running);
    }
    assert.equal(most, 2);

    assert.equal((await tool("gh", ["limit"])).code, 1);
    fs.writeFileSync(log, "");
    const r = await tool("gh", ["a"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /rate limited, retrying in \d+ s/);
    assert.equal(fs.readFileSync(log, "utf8"), ""); // never asked GitHub
  } finally {
    C.programs.gh = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("columnWidth sizes to the longest text, capped, 0 when empty", async () => {
  const { columnWidth } = await import("../src/lib.js");
  assert.equal(columnWidth(["ab", "abcd", undefined], 6.5, 100), 26);
  assert.equal(columnWidth(["x".repeat(50)], 6.5, 100), 100);
  assert.equal(columnWidth(["", null], 6.5, 100), 0);
  assert.equal(columnWidth([], 6.5, 100), 0);
});
