// The prices download, offline: its own file, so no earlier load is cached.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { useConfig } = await import("../src/config.js");
const { usageGroups } = await import("../src/usage.js");

test("usageGroups: a failed prices download keeps the last good copy", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-prices-"));
  process.env.HERDR_APP_HOME = tmp;
  const last = { "gpt-5-codex": { input_cost_per_token: 1e-6 } };
  fs.writeFileSync(path.join(tmp, "usage-prices.json"), JSON.stringify(last));
  const log = path.join(tmp, "codex", "sessions", "rollout-1.jsonl");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(
    log,
    [
      { type: "turn_context", payload: { cwd: "/w", model: "gpt-5-codex" } },
      {
        timestamp: "2026-11-07T11:00:00Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: 1000 },
            last_token_usage: { input_tokens: 1000, output_tokens: 0 },
          },
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n"),
  );
  useConfig({
    usage: {
      agents: [{ type: "codex", home: path.join(tmp, "codex") }],
      prices: `file://${tmp}/missing.json`, // the download fails
    },
  });
  const [g] = await usageGroups();
  assert.ok(Math.abs(g.cost - 1000e-6) < 1e-12, `${g.cost}`);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(tmp, "usage-prices.json"), "utf8")),
    last,
  );
  assert.deepEqual(fs.readdirSync(tmp).sort(), ["codex", "usage-cache", "usage-prices.json"]);
  fs.rmSync(tmp, { recursive: true });
});
