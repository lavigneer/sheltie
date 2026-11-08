// An invalid settings file: the defaults, and a note saying why.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "htf-config-"));
fs.writeFileSync(path.join(home, "ticket-flow.json"), "{ not json");
process.env.HERDR_APP_HOME = home;
const config = await import("../src/config.js");

test("invalid JSON: defaults, with the problem noted", async () => {
  await config.configReady();
  assert.match(config.C.problem, /ticket-flow\.json: .*using the defaults/);
  assert.equal(config.C.tracker, "jira");
});
