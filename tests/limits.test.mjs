// Plan limits of a Claude subscription, from `claude -p /usage`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { useConfig, DEFAULTS } = await import("../src/config.js");
const { planLimits, windows } = await import("../src/limits.js");

const USAGE = `You are currently using your subscription to power your Claude Code usage

Current session: 26% used · resets Nov 8, 4:39pm (America/Edmonton)
Current week (all models): 91% used · resets Nov 14, 5:59pm (America/Edmonton)

Last 24h · 2313 requests · 65 sessions
  43%  Start fresh when you switch tasks · run /clear
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "limits-"));
const sub = path.join(tmp, "sub");
const api = path.join(tmp, "api");
fs.mkdirSync(sub);
fs.mkdirSync(api);
fs.writeFileSync(path.join(sub, "usage.txt"), USAGE);
fs.writeFileSync(path.join(api, "usage.txt"), "You are using an API key\n");
// A stand-in claude: prints its CLAUDE_CONFIG_DIR's usage.txt, or fails.
const claude = path.join(tmp, "claude");
fs.writeFileSync(
  claude,
  '#!/bin/sh\n[ "$*" = "-p --no-session-persistence /usage" ] || exit 2\ncat "$CLAUDE_CONFIG_DIR/usage.txt"\n',
);
fs.chmodSync(claude, 0o755);

const use = (...homes) =>
  useConfig({
    ...DEFAULTS,
    programs: { ...DEFAULTS.programs, claude },
    usage: {
      ...DEFAULTS.usage,
      agents: [
        ...homes.map((home) => ({ type: "claude-code", home })),
        { type: "codex", home: sub },
      ],
    },
  });

test("planLimits: Claude Code homes on a subscription, with their windows", async () => {
  use(sub, api);
  assert.deepEqual(await planLimits(), [
    {
      home: sub,
      windows: [
        { key: "session", label: "Session", used: 26, resets: "Nov 8, 4:39pm" },
        {
          key: "Current week (all models)",
          label: "Week (all models)",
          used: 91,
          resets: "Nov 14, 5:59pm",
        },
      ],
    },
  ]);
});

test("planLimits: a failed run throws", async () => {
  use(path.join(tmp, "missing"));
  await assert.rejects(planLimits(), /Plan limits/);
});

test("windows: text without limits gives none", () => {
  for (const t of [null, "", "43%  Start fresh", "x: 5% used"].slice(0, 3))
    assert.deepEqual(windows(t), []);
  assert.deepEqual(windows("Weekly: 5% used"), [
    { key: "Weekly", label: "Weekly", used: 5, resets: null },
  ]);
});
