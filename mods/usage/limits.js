// Plan limits of a Claude subscription (Pro, Max): how much of the 5-hour
// session and of the week's quota is used, as Claude Code's /usage shows it.
// A subscription is billed by these quotas, not by what its tokens would cost.
//
// Read from Anthropic's OAuth usage endpoint with the token Claude Code signed
// in with: <claude home>/.credentials.json, or on macOS the "Claude Code-
// credentials" Keychain item. Signed in with an API key (no OAuth token), or
// never signed in, there are no limits to show. The token is passed to curl
// on stdin, never as an argument.

import { exec, home } from "herdr";
import { C } from "./config.js";

export const LIMITS_URL = "https://api.anthropic.com/api/oauth/usage";

// $1 = claude home, $2 = jq, $3 = curl, $4 = url. Prints nothing without a
// token; else the response, or fails with curl's error.
const SCRIPT = `creds() {
  if [ -f "$1/.credentials.json" ]; then cat "$1/.credentials.json"
  elif command -v security >/dev/null; then security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null
  fi
}
t=$(creds "$1" | "$2" -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
[ -n "$t" ] || exit 0
printf 'Authorization: Bearer %s\\nanthropic-beta: oauth-2025-04-20\\n' "$t" \\
  | "$3" -sS --fail-with-body --max-time 20 -H @- "$4"`;

// Windows shown, in order: response key -> label.
const WINDOWS = [
  ["five_hour", "Session (5 h)"],
  ["seven_day", "Week"],
  ["seven_day_opus", "Week, Opus"],
  ["seven_day_sonnet", "Week, Sonnet"],
];

// The response's windows: [{ key, label, used (percent), resets (Date | null) }].
// A window that's missing or not a number is left out.
export function windows(body) {
  return WINDOWS.flatMap(([key, label]) => {
    const w = body?.[key];
    if (typeof w?.utilization !== "number") return [];
    const resets = w.resets_at ? new Date(w.resets_at) : null;
    return [
      {
        key,
        label,
        used: w.utilization,
        resets: resets && !Number.isNaN(+resets) ? resets : null,
      },
    ];
  });
}

const expandHome = (p) => p.replace(/^~(?=\/|$)/, home());

// Each Claude Code home's limits: [{ home, windows }], leaving out homes
// without an OAuth token. A failed request throws.
export async function planLimits(url = LIMITS_URL) {
  const homes = C.usage.agents.filter((a) => a.type === "claude-code");
  const out = await Promise.all(
    homes.map(async (a) => {
      const r = await exec("/bin/sh", [
        "-c",
        SCRIPT,
        "sh",
        expandHome(a.home),
        C.programs.jq,
        C.programs.curl,
        url,
      ]);
      if (r.code !== 0)
        throw new Error(
          `Plan limits (${a.home}): ${(r.stderr || r.stdout).trim() || `curl exited ${r.code}`}`,
        );
      if (!r.stdout.trim()) return null;
      let body;
      try {
        body = JSON.parse(r.stdout);
      } catch {
        throw new Error(`Plan limits (${a.home}): not JSON`);
      }
      return { home: a.home, windows: windows(body) };
    }),
  );
  return out.filter((l) => l?.windows.length);
}

// When a window resets, briefly: "in 2h 5m", or a weekday and time.
export function resetsIn(date, now = new Date()) {
  const min = Math.max(0, Math.round((date - now) / 60_000));
  if (min < 60) return `in ${min}m`;
  if (min < 24 * 60) return `in ${Math.floor(min / 60)}h ${min % 60}m`;
  return date.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
