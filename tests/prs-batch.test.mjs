// prDetailsMany (prs.js): the PRs of one repo share GraphQL queries, up to
// PRS_PER_QUERY aliases each, and a query that fails fails only its lookups.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prNode, sandbox } from "./fake-tools.mjs";

const { C } = await import("../src/config.js");
const { prDetailsMany, PRS_PER_QUERY, probePRs } = await import(
  "../src/prs.js"
);

const graphqlCalls = (sb) =>
  sb.ghCalls().filter((a) => a[0] === "api" && a[1] === "graphql").length;

test("prDetailsMany: a number and a branch share one query, each answered", async () => {
  const sb = sandbox({ state: { prs: { feature: prNode(7, "feature") } } });
  const m = await prDetailsMany("me/app", [
    { ref: 7 },
    { ref: "feature" },
    { ref: 8 },
  ]);
  assert.equal(m.get(7).number, 7);
  assert.equal(m.get("feature").number, 7);
  assert.equal(m.get(8), null);
  assert.equal(graphqlCalls(sb), 1);
});

test("prDetailsMany: more than PRS_PER_QUERY lookups take one query per PRS_PER_QUERY", async () => {
  const n = PRS_PER_QUERY + 1;
  const prs = Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`b${i}`, prNode(100 + i, `b${i}`)]),
  );
  const sb = sandbox({ state: { prs } });
  const refs = [...Array.from({ length: n }, (_, i) => `b${i}`), "nobody"];
  assert.equal(refs.length, PRS_PER_QUERY + 2);
  const m = await prDetailsMany(
    "me/app",
    refs.map((ref) => ({ ref })),
  );
  assert.equal(graphqlCalls(sb), 2);
  assert.equal(m.get("b0").number, 100);
  assert.equal(m.get(`b${n - 1}`).number, 100 + n - 1);
  assert.equal(m.get("nobody"), null);
});

test("probePRs: many refs share one query, each answered by number, updatedAt and state", async () => {
  const prs = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`b${i}`, prNode(200 + i, `b${i}`)]),
  );
  const sb = sandbox({ state: { prs } });
  const refs = [...Array.from({ length: 30 }, (_, i) => `b${i}`), 9, "nobody"];
  const m = await probePRs("me/app", refs);
  assert.equal(
    graphqlCalls(sb),
    1,
    "a probe batch is bigger than a lookup batch",
  );
  assert.equal(m.get("b29").number, 229);
  assert.equal(m.get("b29").state, "OPEN");
  assert.equal(typeof m.get("b29").updatedAt, "string");
  assert.equal(m.get(9), null);
  assert.equal(m.get("nobody"), null);
});

test("prDetailsMany: a failed query fails its lookups; a repo that's gone is none", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sheltie-batch-"));
  const gh = path.join(dir, "gh");
  fs.writeFileSync(
    gh,
    `#!/bin/sh
case "$*" in
*"owner=gone"*) echo "Could not resolve to a Repository with the name gone/app." >&2 ;;
*) echo "HTTP 502" >&2 ;;
esac
exit 1
`,
  );
  fs.chmodSync(gh, 0o755);
  const was = C.programs.gh;
  C.programs.gh = gh;
  try {
    const gone = await prDetailsMany("gone/app", [{ ref: 1 }, { ref: "x" }]);
    assert.equal(gone.get(1), null);
    assert.equal(gone.get("x"), null);
    const failed = await prDetailsMany("me/app", [{ ref: 1 }, { ref: "x" }]);
    assert.ok(failed.get(1) instanceof Error);
    assert.ok(failed.get("x") instanceof Error);
    assert.match(failed.get(1).message, /HTTP 502/);
  } finally {
    C.programs.gh = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
