// Plan limits of a Claude subscription, from the OAuth usage endpoint.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { useConfig, DEFAULTS } = await import("../src/config.js");
const { planLimits, resetsIn, windows } = await import("../src/limits.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "limits-"));
const signedIn = path.join(tmp, "signed-in");
const apiKey = path.join(tmp, "api-key");
fs.mkdirSync(signedIn);
fs.mkdirSync(apiKey);
fs.writeFileSync(
  path.join(signedIn, ".credentials.json"),
  JSON.stringify({
    claudeAiOauth: { accessToken: "tok", subscriptionType: "pro" },
  }),
);
const response = path.join(tmp, "usage.json");
fs.writeFileSync(
  response,
  JSON.stringify({
    five_hour: { utilization: 42.4, resets_at: "2026-11-08T15:00:00Z" },
    seven_day: { utilization: 91, resets_at: "2026-11-12T08:00:00Z" },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: "?" },
  }),
);

const use = (...homes) =>
  useConfig({
    ...DEFAULTS,
    usage: {
      ...DEFAULTS.usage,
      agents: [
        ...homes.map((home) => ({ type: "claude-code", home })),
        { type: "codex", home: signedIn },
      ],
    },
  });

test("planLimits: signed-in Claude Code homes only, with their windows", async () => {
  use(signedIn, apiKey);
  const list = await planLimits(`file://${response}`);
  assert.equal(list.length, 1);
  assert.equal(list[0].home, signedIn);
  assert.deepEqual(
    list[0].windows.map((w) => [w.key, w.used, w.resets.toISOString()]),
    [
      ["five_hour", 42.4, "2026-11-08T15:00:00.000Z"],
      ["seven_day", 91, "2026-11-12T08:00:00.000Z"],
    ],
  );
});

test("planLimits: a failed request throws", async () => {
  use(signedIn);
  await assert.rejects(planLimits(`file://${tmp}/missing.json`), /Plan limits/);
});

test("windows: malformed bodies give none", () => {
  for (const b of [null, "x", {}, { five_hour: { utilization: null } }])
    assert.deepEqual(windows(b), []);
  assert.equal(
    windows({ five_hour: { utilization: 1, resets_at: "bad" } })[0].resets,
    null,
  );
});

test("resetsIn", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  assert.equal(resetsIn(new Date("2026-11-08T12:30:00Z"), now), "in 30m");
  assert.equal(resetsIn(new Date("2026-11-08T14:05:00Z"), now), "in 2h 5m");
  assert.equal(resetsIn(new Date("2026-11-08T11:00:00Z"), now), "in 0m");
});
