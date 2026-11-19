// Small helpers shared by every mod (scripts/build.mjs copies the shared
// modules into each mod folder: Herdr only resolves imports inside it).

import { exec, run as herdrRun, spaces } from "herdr";
import { C } from "./config.js";

export const firstLine = (text) => (text || "").trim().split("\n")[0];
// "{name}" placeholders filled from `values`; unknown ones are left as they are.
export const fill = (template, values) =>
  template.replace(/\{(\w+)\}/g, (m, k) => values[k] ?? m);

// Runs one of the configured programs (C.programs: git, gh, jira, hc).
// Calls to the APIs behind gh and jira go through `limits` below.
/** @param {string} name @param {string[]} args @param {{ cwd?: string }} [opts] @returns {Promise<import("herdr").ExecResult>} */
export const tool = (name, args, opts) =>
  limits[name]
    ? limited(limits[name], name, args, opts)
    : run(name, args, opts);

const run = (name, args, opts) => exec(C.programs[name], args, opts);

// GitHub and Jira rate-limit callers. At most `max` of their calls run at once
// (GitHub's secondary limits punish bursts). When one answers "rate limited",
// every call to that program fails at once, without asking, until the backoff
// (a minute, doubling up to 15 on repeats) has passed; a call that works
// resets it. Shared by everything in a mod, so polls, popups and steps can't
// pile on together.
export const RATE_LIMITED =
  /rate limit|too many requests|\b429\b|abuse detection/i;
const BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const limits = {
  gh: { max: 2, active: 0, waiting: [], until: 0, backoff: 0 },
  jira: { max: 2, active: 0, waiting: [], until: 0, backoff: 0 },
};

async function limited(l, name, args, opts) {
  if (l.active >= l.max) await new Promise((go) => l.waiting.push(go));
  l.active++;
  try {
    const wait = l.until - Date.now();
    if (wait > 0)
      return {
        code: 1,
        stdout: "",
        stderr: `${name}: rate limited, retrying in ${Math.ceil(wait / 1000)} s`,
      };
    const r = await run(name, args, opts);
    if (r.code !== 0 && RATE_LIMITED.test(`${r.stderr}\n${r.stdout}`)) {
      l.backoff = Math.min(
        l.backoff ? l.backoff * 2 : BACKOFF_MS,
        MAX_BACKOFF_MS,
      );
      l.until = Date.now() + l.backoff;
    } else if (r.code === 0) l.backoff = 0;
    return r;
  } finally {
    l.active--;
    l.waiting.shift()?.();
  }
}

// Runs a program and returns its stdout, or throws with its first error line.
/** @param {string} name @param {string[]} args @param {string} [what] @param {{ cwd?: string }} [opts] @returns {Promise<string>} */
export async function must(name, args, what, opts) {
  const r = await tool(name, args, opts);
  if (r.code !== 0)
    throw new Error(
      firstLine(r.stderr) || firstLine(r.stdout) || `${what ?? name} failed`,
    );
  return r.stdout;
}

// A tracker or GitHub saying "there's no such thing" (as opposed to failing).
export const NOT_FOUND =
  /does not exist|not found|404|no pull requests? found|could not resolve/i;

// Runs `tasks` (functions returning promises) a few at a time; a failed task
// gives null.
/** @template T @param {(() => Promise<T>)[]} tasks @param {number} [size] @returns {Promise<(T | null)[]>} */
export async function pool(tasks, size = 4) {
  const out = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]().catch(() => null);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(size, tasks.length) }, worker),
  );
  return out;
}

// Opens a URL in the browser (xdg-open on Linux, open on macOS).
export async function openUrl(url) {
  try {
    const r = await exec("xdg-open", [url]);
    if (r.code === 0) return;
  } catch {
    // not Linux
  }
  await exec("open", [url]).catch(() => {});
}

export const basename = (p) => p.replace(/\/+$/, "").split("/").pop();
export const inside = (dir, root) => dir === root || dir.startsWith(`${root}/`);

// Subsequence match ("dtf" matches "dotfiles"); a lower score is a better match,
// null is no match.
export function score(text, query) {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return direct;
  let at = -1;
  let gaps = 0;
  for (const ch of q) {
    const next = t.indexOf(ch, at + 1);
    if (next < 0) return null;
    gaps += next - at - 1;
    at = next;
  }
  return 100 + gaps;
}

// Closes every local space started inside `dir` (its work is done there).
export function closeSpacesIn(dir) {
  for (const s of spaces())
    if (!s.machine && s.folder && inside(s.folder, dir))
      herdrRun("space.close", { id: s.id, confirmed: true });
}

// Up/Down and Ctrl+N/Ctrl+P move a selection through `n` rows; Esc calls `close`.
// Returns true when it handled the key.
export function moveKey(e, view, n, close) {
  const k = e.key;
  if (k === "escape") {
    close();
    return true;
  }
  if (k === "down" || (k === "n" && e.modifiers.control))
    view.at = (view.at + 1) % Math.max(n, 1);
  else if (k === "up" || (k === "p" && e.modifiers.control))
    view.at = (view.at + Math.max(n, 1) - 1) % Math.max(n, 1);
  else return false;
  return true;
}

// The index `delta` steps from `at` among `n` items, wrapping around.
export const cycle = (n, at, delta) => (((at + delta) % n) + n) % n;

// A column's width for the longest of `texts`, estimated at `perChar` px a
// character (text can't be measured from a mod) and capped at `max`: 0 when
// they're all empty, so the column can go and give its space to the rest.
export const columnWidth = (texts, perChar, max) => {
  const longest = Math.max(0, ...texts.map((s) => (s ?? "").length));
  return longest ? Math.min(max, Math.ceil(longest * perChar)) : 0;
};

// An error's first line, for a notification.
export const errorText = (e) =>
  firstLine(`${e?.message ?? e}`) || "Something went wrong";
