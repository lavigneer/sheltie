// npm run bench:usage [MB]: times the usage scan on a synthetic Claude Code
// history of about MB megabytes (default 500), in 64 logs, in a temp folder:
// the cold scan (no cache), a forced rescan (every log cached) and a rescan
// after one log grew. Run it through the test loader, as the tests are:
//   node --import ./tests/register.mjs scripts/bench-usage.mjs 500
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mb = Number(process.argv[2] ?? 500);
const logs = 64;
const root = mkdtempSync(join(tmpdir(), "sheltie-bench-usage-"));
const home = join(root, "claude");
const app = join(root, "app");
const proj = join(home, "projects", "-work-repo");
mkdirSync(proj, { recursive: true });
mkdirSync(app, { recursive: true });

// Mostly lines the reader skips (prompts, tool results), one assistant message
// with usage in about one line in three.
const pad = "x".repeat(300);
let id = 0;
const perLog = Math.floor((mb * 1e6) / logs);
for (let f = 0; f < logs; f++) {
  const lines = [];
  for (let bytes = 0; bytes < perLog; ) {
    id++;
    const r = Math.random();
    const line =
      r < 0.4
        ? {
            type: "user",
            timestamp: "2026-11-07T10:00:00Z",
            cwd: "/w",
            message: { role: "user", content: pad },
          }
        : r < 0.7
          ? {
              type: "tool_result",
              timestamp: "2026-11-07T10:00:00Z",
              cwd: "/w",
              content: pad + pad + pad,
            }
          : {
              type: "assistant",
              timestamp: `2026-11-0${1 + (f % 9)}T10:00:00Z`,
              cwd: `/w/.worktrees/t${f % 5}`,
              message: {
                id: `m${id}`,
                model: "claude-opus-5-5",
                content: pad,
                usage: {
                  input_tokens: 10,
                  output_tokens: 200,
                  cache_read_input_tokens: 5000,
                  cache_creation_input_tokens: 300,
                  cache_creation: {
                    ephemeral_5m_input_tokens: 0,
                    ephemeral_1h_input_tokens: 300,
                  },
                },
              },
            };
    const s = JSON.stringify(line);
    lines.push(s);
    bytes += s.length + 1;
  }
  writeFileSync(join(proj, `s${f}.jsonl`), lines.join("\n") + "\n");
}

const prices = join(app, "prices.json");
writeFileSync(
  prices,
  JSON.stringify({
    "claude-opus-5-5": {
      input_cost_per_token: 4e-6,
      output_cost_per_token: 2e-5,
    },
  }),
);
process.env.HERDR_APP_HOME = app;
const { useConfig } = await import("../src/config.js");
const { usageGroups } = await import("../src/usage.js");
useConfig({
  usage: {
    agents: [{ type: "claude-code", home }],
    prices: `file://${prices}`,
  },
});

const time = async (label, fn) => {
  const t0 = performance.now();
  await fn();
  console.log(`${label}: ${Math.round(performance.now() - t0)} ms`);
};
console.log(`history: ${mb} MB in ${logs} logs`);
await time("cold scan", () => usageGroups(0));
await time("forced rescan, nothing changed", () => usageGroups(0));
const changed = join(proj, "s0.jsonl");
const later = new Date(Date.now() + 5000);
utimesSync(changed, later, later);
await time("forced rescan, one log changed", () => usageGroups(0));

rmSync(root, { recursive: true, force: true });
