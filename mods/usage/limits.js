// Plan limits of a Claude subscription (Pro, Max): how much of the 5-hour
// session and of the week's quota is used. A subscription is billed by these
// quotas, not by what its tokens would cost.
//
// Read from Claude Code itself: `claude -p /usage` (run with CLAUDE_CONFIG_DIR
// set to the agent's home, unless that's the default ~/.claude: on macOS a set
// CLAUDE_CONFIG_DIR, even the default, has its own keychain login, so the
// subscription's isn't found and no limits are shown) prints what its /usage shows, without calling a
// model. Without claude installed, or with no claude-code agent in
// usage.agents, nothing is run or shown. Its lines "<label>: <n>% used · resets <when>" are the windows; an
// account billed per token (API key) prints none, and shows no limits.

import { exec, home } from "herdr";
import { C } from "./config.js";

// The windows in /usage's text: [{ key, label, used (percent), resets
// (text, or null) }]. key is "session" for the 5-hour window.
/** @param {string} text */
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
    // "Nov 8, 4:39pm (America/Edmonton)", or "Nov 8 at 4:39pm (...)" in newer
    // Claude Codes: the zone is yours, so left out; "at" made ", " for both.
    resets: resets
      ? resets.replace(/\s*\([^)]*\)$/, "").replace(/^(\w+ \d+) at /, "$1, ")
      : null,
  }));
}

/** @param {string} p */
const expandHome = (p) => p.replace(/^~(?=\/|$)/, home());

// CLAUDE_CONFIG_DIR for a Claude Code home: "" (unset, even if Herdr has it)
// for the default.
/** @param {string} h */
export const configDir = (h) => {
  const dir = expandHome(h).replace(/\/+$/, "");
  return dir === `${home()}/.claude` ? "" : dir;
};

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
          // 127 when claude isn't there (macOS sh's exec says 126).
          'command -v "$2" >/dev/null || exit 127; if [ -n "$1" ]; then export CLAUDE_CONFIG_DIR="$1"; else unset CLAUDE_CONFIG_DIR; fi; exec "$2" -p --no-session-persistence /usage',
          "sh",
          configDir(a.home),
          C.programs.claude,
        ],
        { cwd: home() },
      );
      // No claude on the PATH: not a Claude Code user, nothing to show.
      if (r.code === 127) return null;
      if (r.code !== 0)
        throw new Error(
          `Plan limits (${a.home}): ${(r.stderr || r.stdout).trim() || `claude exited ${r.code}`}`,
        );
      return { home: a.home, windows: windows(r.stdout) };
    }),
  );
  return out.filter((l) => l?.windows.length);
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

// A window's reset as a label: "resets 9:39pm" today, else "resets Nov 14,
// 5:59pm". resets is windows()'s text ("Nov 8, 4:39pm"); null gives "".
/** @param {string | null | undefined} resets @param {Date} [now] */
export function resetsLabel(resets, now = new Date()) {
  if (!resets) return "";
  const today = `${MONTHS[now.getMonth()]} ${now.getDate()}, `;
  return `resets ${resets.startsWith(today) ? resets.slice(today.length) : resets}`;
}
