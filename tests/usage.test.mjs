// Agent cost from Claude Code and Codex session logs, priced from a
// LiteLLM-format list.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { useConfig } = await import("../src/config.js");
const { costIn, costOf, total, usageGroups } = await import("../src/usage.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
process.env.HERDR_APP_HOME = tmp;
const M = 1e-6;
fs.writeFileSync(
  path.join(tmp, "prices.json"),
  JSON.stringify({
    sample_spec: { note: "not a model" },
    "claude-opus-5-5": {
      input_cost_per_token: 4 * M,
      output_cost_per_token: 20 * M,
      cache_creation_input_token_cost: 5 * M,
      cache_creation_input_token_cost_above_1hr: 8 * M,
      cache_read_input_token_cost: 0.2 * M,
      provider_specific_entry: { fast: 2 },
    },
    "gpt-5-codex": {
      input_cost_per_token: 1 * M,
      output_cost_per_token: 10 * M,
      cache_read_input_token_cost: 0.1 * M,
    },
  }),
);

const write = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n"));
};
const claude = (id, cwd, usage, model = "claude-opus-5-5") =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-07T10:00:00Z",
    cwd,
    message: { id, model, usage },
  });

test("usageGroups: Claude Code and Codex, by folder, priced", async () => {
  const wt = "/work/repo/.worktrees/issue-1";
  const u = {
    input_tokens: 1000,
    output_tokens: 2000,
    cache_read_input_tokens: 10000,
    cache_creation_input_tokens: 4000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4000 },
  };
  const proj = path.join(tmp, "claude", "projects", "-work-repo");
  write(path.join(proj, "s1.jsonl"), [
    claude("a", wt, u),
    claude("a", wt, u), // the same message's next content block
    '{"type":"user"}',
    claude("b", "/work/repo", u, "<synthetic>"),
    "{half written", // must not swallow the next file's first line
  ]);
  write(path.join(proj, "s1", "subagents", "x.jsonl"), [
    claude("c", wt, { input_tokens: 1e6, output_tokens: 0, speed: "fast" }),
  ]);
  const usage = (total, last) => ({
    timestamp: "2026-11-07T11:00:00Z",
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: last } },
  });
  const call = { input_tokens: 3000, cached_input_tokens: 1000, output_tokens: 500 };
  write(path.join(tmp, "codex", "sessions", "2026", "11", "07", "rollout-1.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/work/repo" } }),
    JSON.stringify({ type: "turn_context", payload: { cwd: "/work/repo", model: "gpt-5-codex" } }),
    JSON.stringify(usage(3500, call)),
    JSON.stringify(usage(3500, call)), // repeated: not a new call
    JSON.stringify(usage(7000, call)),
  ]);
  useConfig({
    usage: {
      agents: [
        { type: "claude-code", home: path.join(tmp, "claude") },
        { type: "codex", home: path.join(tmp, "codex") },
        { type: "codex", home: path.join(tmp, "never-used") },
      ],
      prices: `file://${tmp}/prices.json`,
    },
  });
  const groups = await usageGroups();
  assert.equal(groups.length, 3);
  const opus = groups.find((g) => g.agent === "claude-code" && !g.fast);
  assert.deepEqual(
    { dir: opus.dir, day: opus.day, input: opus.input, write1h: opus.write1h },
    { dir: wt, day: "2026-11-07", input: 1000, write1h: 4000 },
  );
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  near(opus.cost, (1000 * 4 + 4000 * 8 + 10000 * 0.2 + 2000 * 20) * M);
  near(costIn(groups, wt), opus.cost + 8); // fast: 1M input at 2x $4
  const codex = groups.find((g) => g.agent === "codex");
  assert.deepEqual([codex.input, codex.read, codex.output], [4000, 2000, 1000]);
  near(costIn(groups, "/work/repo"), (4000 * 1 + 2000 * 0.1 + 1000 * 10) * M);
});

test("costOf: unknown models have no price; dated ids match; totals", () => {
  const table = { "claude-haiku-4-5": { i: 1 * M, o: 5 * M } };
  const base = { input: 1e6, output: 0, read: 0, write5m: 0, write1h: 0 };
  assert.equal(costOf(table, { ...base, model: "mystery" }), null);
  assert.equal(costOf(table, { ...base, model: "claude-haiku-4-5-20251001" }), 1);
  assert.deepEqual(
    total([
      { ...base, cost: null },
      { ...base, cost: 4 },
    ]),
    { cost: 4, tokens: 2e6, unpriced: 1e6 },
  );
});
