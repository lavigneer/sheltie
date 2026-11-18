// Plan limits of a Claude subscription, from `claude -p /usage`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { useConfig, DEFAULTS } = await import("../src/config.js");
const { configDir, planLimits, windows } = await import("../src/limits.js");

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

test("planLimits: without claude installed, none and no error", async () => {
  useConfig({
    ...DEFAULTS,
    programs: { ...DEFAULTS.programs, claude: path.join(tmp, "no-claude") },
    usage: { ...DEFAULTS.usage, agents: [{ type: "claude-code", home: sub }] },
  });
  assert.deepEqual(await planLimits(), []);
});

test("windows: text without limits gives none", () => {
  for (const t of [null, "", "43%  Start fresh", "x: 5% used"].slice(0, 3))
    assert.deepEqual(windows(t), []);
  assert.deepEqual(windows("Weekly: 5% used"), [
    { key: "Weekly", label: "Weekly", used: 5, resets: null },
  ]);
});

test("resetsLabel leaves out today's date", async () => {
  const { resetsLabel } = await import("../src/limits.js");
  const now = new Date(2026, 10, 8, 12);
  assert.equal(resetsLabel("Nov 8, 4:39pm", now), "resets 4:39pm");
  assert.equal(resetsLabel("Nov 14, 5:59pm", now), "resets Nov 14, 5:59pm");
  assert.equal(resetsLabel("Nov 18, 1am", now), "resets Nov 18, 1am");
  assert.equal(resetsLabel(null, now), "");
});

test('windows: newer Claude Code\'s "Nov 18 at 2:30am" resets read as "Nov 18, 2:30am"', () => {
  assert.deepEqual(
    windows(
      "Current session: 42% used · resets Nov 18 at 2:30am (America/Edmonton)",
    ),
    [{ key: "session", label: "Session", used: 42, resets: "Nov 18, 2:30am" }],
  );
});

test("configDir: the default ~/.claude leaves CLAUDE_CONFIG_DIR unset", () => {
  const h = os.homedir();
  assert.equal(configDir("~/.claude"), "");
  assert.equal(configDir(`${h}/.claude/`), "");
  assert.equal(configDir("~/.claude-work"), `${h}/.claude-work`);
});

test("planLimits: the default home runs claude without CLAUDE_CONFIG_DIR", async () => {
  const bin = path.join(tmp, "claude-env");
  fs.writeFileSync(
    bin,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template.
    '#!/bin/sh\nif [ -n "${CLAUDE_CONFIG_DIR+x}" ]; then echo "x: 1% used"; else echo "Current session: 7% used"; fi\n',
  );
  fs.chmodSync(bin, 0o755);
  useConfig({
    ...DEFAULTS,
    programs: { ...DEFAULTS.programs, claude: bin },
    usage: {
      ...DEFAULTS.usage,
      agents: [{ type: "claude-code", home: "~/.claude" }],
    },
  });
  process.env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), ".claude");
  try {
    const [l] = await planLimits();
    assert.equal(l.windows[0].key, "session");
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});
