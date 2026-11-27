// demo/state.sh's state_set: parallel writers lose no update, and a lock left
// by a dead writer is taken over. The fake gh runs state_tick before every
// call, so the mods' concurrent calls all queue on this lock.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { root } from "./demo.mjs";

const run = promisify(execFile);

// A demo folder whose state.json is { n: 0 }.
function demoFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-state-"));
  fs.writeFileSync(path.join(dir, "state.json"), '{"n":0}');
  return dir;
}

// Runs `script` with state.sh sourced and HERDR_DEMO set to dir.
const sourced = (dir, script) =>
  run("bash", ["-c", `. "$0"; ${script}`, path.join(root, "demo/state.sh")], {
    env: { ...process.env, HERDR_DEMO: dir },
  });

test("state_set: parallel writers lose no update", async () => {
  const dir = demoFolder();
  const writers = Array.from({ length: 30 }, () =>
    sourced(dir, "state_set '.n += 1'"),
  );
  await Promise.all(writers);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"))).n, 30);
  assert.equal(fs.existsSync(path.join(dir, "state.json.lock")), false);
});

test("state_set: a lock whose writer is gone is taken over", async () => {
  const dir = demoFolder();
  // A symlink to a pid that no longer exists, as a killed writer leaves it.
  fs.symlinkSync("999999", path.join(dir, "state.json.lock"));
  await sourced(dir, "state_set '.n += 1'");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"))).n, 1);
  assert.equal(fs.existsSync(path.join(dir, "state.json.lock")), false);
});
