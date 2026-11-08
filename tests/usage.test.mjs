// Agent cost from Claude Code transcripts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { useConfig } = await import("../src/config.js");
const { costIn, costOf, folderOf, total, usageGroups } = await import("../src/usage.js");

const msg = (id, model, usage, ts = "2026-11-07T10:00:00Z") =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model, usage } });

test("usageGroups: sums each message once per folder, day and model", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
  const dir = "/work/repo/.worktrees/issue-1";
  const proj = path.join(home, "projects", folderOf(dir));
  fs.mkdirSync(path.join(proj, "s1", "subagents"), { recursive: true });
  const u = {
    input_tokens: 1000,
    output_tokens: 2000,
    cache_read_input_tokens: 10000,
    cache_creation_input_tokens: 4000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4000 },
  };
  fs.writeFileSync(
    path.join(proj, "s1.jsonl"),
    [
      msg("a", "claude-opus-5-5", u),
      msg("a", "claude-opus-5-5", u), // the same message's next block
      '{"type":"user"}',
      "{not json", // a line still being written
      msg("b", "<synthetic>", u),
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(proj, "s1", "subagents", "x.jsonl"),
    msg("c", "claude-haiku-5-5", { input_tokens: 1e6, output_tokens: 0 }),
  );
  useConfig({ usage: { claudeHomes: [home, path.join(home, "missing")] } });
  const groups = await usageGroups();
  assert.equal(groups.length, 2);
  const opus = groups.find((g) => g.model === "claude-opus-5-5");
  assert.deepEqual(
    { folder: opus.folder, day: opus.day, input: opus.input, write1h: opus.write1h, write5m: opus.write5m },
    { folder: folderOf(dir), day: "2026-11-07", input: 1000, write1h: 4000, write5m: 0 },
  );
  // $4 in, $20 out, $0.20 read, 1h writes 2x input.
  const want = (1000 * 4 + 4000 * 8 + 10000 * 0.2 + 2000 * 20) / 1e6;
  assert.ok(Math.abs(opus.cost - want) < 1e-12);
  assert.ok(Math.abs(costIn(groups, dir) - (want + 0.1)) < 1e-12);
  assert.equal(costIn(groups, "/work/repo"), null);
});

test("costOf: unknown models have no price; fast mode doubles; dated ids match", () => {
  const base = { input: 1e6, output: 0, read: 0, write5m: 0, write1h: 0 };
  assert.equal(costOf({ ...base, model: "gpt-x" }), null);
  assert.equal(costOf({ ...base, model: "claude-opus-5-5", fast: true }), 8);
  assert.equal(costOf({ ...base, model: "claude-haiku-4-5-20251001" }), 1);
  const t = total([
    { ...base, model: "gpt-x", cost: null },
    { ...base, model: "claude-opus-5-5", cost: 4 },
  ]);
  assert.deepEqual(t, { cost: 4, tokens: 2e6, unpriced: 1e6 });
});
