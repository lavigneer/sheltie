// Loading settings: defaults without a file, defaults plus a note for a bad one.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const config = await import("../src/config.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "htf-config-"));
process.env.HERDR_APP_HOME = home;

test("no settings file: the defaults, programs found on PATH", async () => {
  await config.configReady();
  assert.equal(config.C.problem, null);
  assert.equal(config.C.tracker, "jira");
  assert.deepEqual(config.C.roots, [`${os.homedir()}/workspace`]);
  assert.ok(config.C.programs.git.startsWith("/"), config.C.programs.git);
});

test("merge: objects key by key, everything else replaced", () => {
  const m = config.merge(config.DEFAULTS, {
    jira: { transitions: { start: "In Progress" } },
    roots: ["/src"],
  });
  assert.deepEqual(m.jira.transitions, {
    start: "In Progress",
    review: null,
    done: "Resolved",
  });
  assert.deepEqual(m.roots, ["/src"]);
  assert.equal(m.jira.jql, config.DEFAULTS.jira.jql);
});

test("useConfig: ~ in roots is the home folder", () => {
  config.useConfig({ roots: ["~/code", "/abs"] });
  assert.deepEqual(config.C.roots, [`${os.homedir()}/code`, "/abs"]);
});
