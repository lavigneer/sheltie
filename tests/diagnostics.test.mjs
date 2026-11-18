import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DIAGNOSTICS_DIR, KEEP, recordFailure } from "../src/diagnostics.js";

const tmpHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sheltie-diag-"));
  process.env.HERDR_APP_HOME = dir;
  return dir;
};
const quiet = (f) => async () => {
  const err = console.error;
  console.error = () => {};
  try {
    await f();
  } finally {
    console.error = err;
  }
};

test(
  "a failure is recorded as JSON with its message, stack and context",
  quiet(async () => {
    const home = tmpHome();
    await recordFailure("work", "Finish", new Error("boom"), { path: "/x" });
    const dir = path.join(home, DIAGNOSTICS_DIR);
    const [file] = fs.readdirSync(dir);
    const r = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    assert.equal(r.mod, "work");
    assert.equal(r.what, "Finish");
    assert.equal(r.message, "boom");
    assert.match(r.stack, /boom/);
    assert.deepEqual(r.context, { path: "/x" });
  }),
);

test(
  "only the newest records are kept",
  quiet(async () => {
    const home = tmpHome();
    for (let i = 0; i < KEEP + 5; i++) await recordFailure("t", `n${i}`, "x");
    const dir = path.join(home, DIAGNOSTICS_DIR);
    const files = fs.readdirSync(dir).sort();
    assert.equal(files.length, KEEP);
    const last = JSON.parse(
      fs.readFileSync(path.join(dir, files.at(-1)), "utf8"),
    );
    assert.equal(last.what, `n${KEEP + 4}`);
  }),
);

test(
  "recording never throws",
  quiet(async () => {
    process.env.HERDR_APP_HOME = "/dev/null/nope";
    await recordFailure("t", "x", new Error("y"));
  }),
);

test(
  "diagnostics.sh redacts secrets and includes recorded failures",
  quiet(async () => {
    const home = tmpHome();
    fs.writeFileSync(
      path.join(home, "sheltie.json"),
      JSON.stringify({ tracker: "jira", jira: { apiToken: "s3cret" } }),
    );
    await recordFailure("tickets", "load", new Error("jira said no"));
    const md = execFileSync(
      "bash",
      ["diagnostics.sh", "--home", home, "--out", "-"],
      { encoding: "utf8", env: { ...process.env, PATH: process.env.PATH } },
    );
    assert.doesNotMatch(md, /s3cret/);
    assert.match(md, /<redacted>/);
    assert.match(md, /jira said no/);
    assert.match(md, /## Versions/);
  }),
);
