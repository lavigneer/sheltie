// Plan limits of a Claude subscription (Pro, Max): how much of the 5-hour
// session and of the week's quota is used. A subscription is billed by these
// quotas, not by what its tokens would cost.
//
// Read from Claude Code itself: `claude -p /usage` (run with CLAUDE_CONFIG_DIR
// set to the agent's home) prints what its /usage shows, without calling a
// model. Its lines "<label>: <n>% used · resets <when>" are the windows; an
// account billed per token (API key) prints none, and shows no limits.

import { exec, home } from "herdr";
import { C } from "./config.js";

// The windows in /usage's text: [{ key, label, used (percent), resets
// (text, or null) }]. key is "session" for the 5-hour window.
export function windows(text) {
  return [
    ...`${text ?? ""}`.matchAll(
      /^\s*(.+?):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+?))?\s*$/gm,
    ),
  ].map(([, label, used, resets]) => ({
    key: /session/i.test(label) ? "session" : label,
    label: label
      .replace(/^Current\s+/i, "")
      .replace(/^./, (c) => c.toUpperCase()),
    used: Number(used),
    // "Nov 8, 4:39pm (America/Edmonton)": the zone is yours, so left out.
    resets: resets ? resets.replace(/\s*\([^)]*\)$/, "") : null,
  }));
}

const expandHome = (p) => p.replace(/^~(?=\/|$)/, home());

// Each Claude Code home's limits: [{ home, windows }], leaving out homes
// without any (not on a subscription). A failed run throws.
export async function planLimits() {
  const homes = C.usage.agents.filter((a) => a.type === "claude-code");
  const out = await Promise.all(
    homes.map(async (a) => {
      const r = await exec(
        "/bin/sh",
        [
          "-c",
          'CLAUDE_CONFIG_DIR="$1" exec "$2" -p --no-session-persistence /usage',
          "sh",
          expandHome(a.home),
          C.programs.claude,
        ],
        { cwd: home() },
      );
      if (r.code !== 0)
        throw new Error(
          `Plan limits (${a.home}): ${(r.stderr || r.stdout).trim() || `claude exited ${r.code}`}`,
        );
      return { home: a.home, windows: windows(r.stdout) };
    }),
  );
  return out.filter((l) => l.windows.length);
}
