// Property tests: the usage readers against malformed, still-being-written
// session logs. Each case is generated from a seed; a failure names it, and
// FUZZ_SEED=<seed> runs just that one.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { useConfig } = await import("../src/config.js");
const { usageGroups } = await import("../src/usage.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-fuzz-"));
process.env.HERDR_APP_HOME = tmp;
fs.writeFileSync(path.join(tmp, "prices.json"), "{}");

const SEEDS = process.env.FUZZ_SEED
  ? [Number(process.env.FUZZ_SEED)]
  : Array.from({ length: 15 }, () => Math.floor(Math.random() * 2 ** 32));

// mulberry32
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const int = (n) => Math.floor(next() * n);
  return { next, int, pick: (xs) => xs[int(xs.length)] };
}

// A token field as a log might hold it, and what it counts as.
const tokenValue = (r) =>
  r.pick([
    () => r.int(5000),
    () => r.int(5000),
    () => r.int(5000),
    () => -r.int(5000),
    () => String(r.int(5000)),
    () => null,
    () => undefined,
    () => ({ n: 1 }),
  ])();
const counted = (v) => (typeof v === "number" && v > 0 ? v : 0);

const junk = (r) =>
  r.pick([
    () => "",
    () => "not json",
    () => "42",
    () => '"a string"',
    () => "[1,2]",
    () => "null",
    () => '{"type":"assistant","message":"oops"}',
    () => '{"type":"assistant","message":{"id":7,"model":"m","usage":{}}}',
    () => '{"type":"assistant","message":{"id":"x","model":3,"usage":{}}}',
    () =>
      Buffer.from(Array.from({ length: 12 }, () => r.int(256))).toString(
        "latin1",
      ),
  ])();

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "latin1");
};

const scan = async (agent, home) => {
  useConfig({
    usage: {
      agents: [{ type: agent, home }],
      prices: `file://${tmp}/prices.json`,
    },
  });
  return usageGroups(0);
};

const FIELDS = ["input", "output", "read", "write5m", "write1h"];
const sums = (groups) =>
  Object.fromEntries(
    FIELDS.map((f) => [f, groups.reduce((n, g) => n + g[f], 0)]),
  );
const nonNegative = (groups, why) => {
  for (const g of groups)
    for (const f of FIELDS)
      assert.ok(g[f] >= 0, `${why}: negative ${f} in ${JSON.stringify(g)}`);
};

// Claude Code: messages from a small pool of ids, repeated within and across
// files (each id always the same message), between junk; any file may end in
// a half-written line.
function claudeCase(seed, home) {
  const r = rng(seed);
  const messages = Array.from({ length: 12 }, (_, k) => {
    const usage = {
      input_tokens: tokenValue(r),
      output_tokens: tokenValue(r),
      cache_read_input_tokens: tokenValue(r),
      cache_creation_input_tokens: tokenValue(r),
    };
    if (r.next() < 0.5)
      usage.cache_creation = {
        ephemeral_5m_input_tokens: tokenValue(r),
        ephemeral_1h_input_tokens: tokenValue(r),
      };
    const broken = r.pick([null, null, null, "usage", "model", "synthetic"]);
    const message = { id: `msg-${seed}-${k}`, model: "claude-x", usage };
    if (broken === "usage") delete message.usage;
    if (broken === "model") delete message.model;
    if (broken === "synthetic") message.model = "<synthetic>";
    const line = JSON.stringify({
      type: "assistant",
      timestamp: r.pick(["2026-11-07T10:00:00Z", 12, undefined]),
      cwd: r.pick(["/w", ["no"], undefined]),
      message,
    });
    const cc = usage.cache_creation;
    const expect = broken
      ? null
      : {
          input: counted(usage.input_tokens),
          output: counted(usage.output_tokens),
          read: counted(usage.cache_read_input_tokens),
          write5m: cc
            ? counted(cc.ephemeral_5m_input_tokens)
            : counted(usage.cache_creation_input_tokens),
          write1h: cc ? counted(cc.ephemeral_1h_input_tokens) : 0,
        };
    return { line, expect };
  });
  const complete = new Set();
  const files = 1 + r.int(4);
  for (let f = 0; f < files; f++) {
    const lines = [];
    for (let n = r.int(15); n > 0; n--) {
      if (r.next() < 0.3) lines.push(junk(r));
      else {
        const k = r.int(messages.length);
        lines.push(messages[k].line);
        complete.add(k);
      }
    }
    let text = lines.join("\n");
    // Half-written: a message cut short, never seen whole anywhere else.
    if (r.next() < 0.6) {
      const k = r.int(messages.length);
      if (!complete.has(k)) {
        const l = messages[k].line;
        text += `${text ? "\n" : ""}${l.slice(0, 1 + r.int(l.length - 1))}`;
      }
    }
    write(path.join(home, "projects", `-p${f % 2}`, `s${f}.jsonl`), text);
  }
  // A cut line is only ever a prefix, so it can't have marked its id complete.
  const want = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  for (const k of complete)
    if (messages[k].expect)
      for (const f of FIELDS) want[f] += messages[k].expect[f];
  return want;
}

// Codex: one session's events in order, with junk between, models of the
// wrong type, repeated totals and a cut last line.
function codexCase(seed, home) {
  const r = rng(seed);
  const lines = [];
  const want = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  let model = null;
  let last; // the last counted event's total
  for (let n = 5 + r.int(25); n > 0; n--) {
    const kind = r.pick(["junk", "meta", "turn", "count", "count", "count"]);
    if (kind === "junk") lines.push(junk(r));
    else if (kind === "meta")
      lines.push(
        JSON.stringify({ type: "session_meta", payload: { cwd: "/w" } }),
      );
    else if (kind === "turn") {
      const m = r.pick(["gpt-x", "gpt-y", 5, null]);
      if (typeof m === "string") model = m;
      lines.push(
        JSON.stringify({
          type: "turn_context",
          payload: { cwd: "/w", model: m },
        }),
      );
    } else {
      const total = r.next() < 0.3 && last !== undefined ? last : r.int(1e6);
      const u = {
        input_tokens: tokenValue(r),
        cached_input_tokens: tokenValue(r),
        output_tokens: tokenValue(r),
      };
      lines.push(
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-11-07T11:00:00Z",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { total_tokens: total },
              last_token_usage: u,
            },
          },
        }),
      );
      if (model && total !== last) {
        last = total;
        const input = counted(u.input_tokens);
        const cached = counted(u.cached_input_tokens);
        want.input += Math.max(0, input - cached);
        want.read += cached;
        want.output += counted(u.output_tokens);
      }
    }
  }
  const cut = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 1 } },
    },
  });
  write(
    path.join(home, "sessions", "2026", "11", "07", "rollout.jsonl"),
    `${lines.join("\n")}\n${cut.slice(0, r.int(cut.length))}`,
  );
  return want;
}

for (const [agent, make] of [
  ["claude-code", claudeCase],
  ["codex", codexCase],
])
  test(`usage fuzz: ${agent} survives malformed logs`, async () => {
    for (const seed of SEEDS) {
      const why = `${agent} FUZZ_SEED=${seed}`;
      const home = path.join(tmp, agent, String(seed));
      const want = make(seed, home);
      const groups = await scan(agent, home).catch((e) =>
        assert.fail(`${why}: scan failed: ${e.message}`),
      );
      nonNegative(groups, why);
      assert.deepEqual(sums(groups), want, why);
    }
  });
