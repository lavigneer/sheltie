// Small helpers shared by every mod (scripts/build.mjs copies the shared
// modules into each mod folder: Herdr only resolves imports inside it).

import { exec, panes, spaces } from "herdr";
import { C } from "./config.js";

export const firstLine = (text) => (text || "").trim().split("\n")[0];
// "{name}" placeholders filled from `values`; unknown ones are left as they are.
export const fill = (template, values) =>
  template.replace(/\{(\w+)\}/g, (m, k) => values[k] ?? m);

// Runs one of the configured programs (C.programs: git, gh, jira, hc).
export const tool = (name, args, opts) => exec(C.programs[name], args, opts);

// Runs a program and returns its stdout, or throws with its first error line.
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
export const inside = (dir, root) => dir === root || dir.startsWith(root + "/");

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

// The local space already working in `dir`: its start folder, else any of its
// terminals. Folders inside `except` don't count as in `dir` (a repo's main
// checkout holds its worktrees: see hubExcept in data.js). A space started in
// a folder above `dir` or inside `except` belongs there, wherever its
// terminals are: a hub's space is never one of its worktrees', nor the other
// way round.
export function spaceFor(dir, except = []) {
  const ok = (p) =>
    Boolean(p) && inside(p, dir) && !except.some((e) => inside(p, e));
  const local = spaces().filter((s) => !s.machine);
  const byFolder = local.find((s) => ok(s.folder));
  if (byFolder) return byFolder;
  const elsewhere = (f) =>
    Boolean(f) &&
    ((f !== dir && inside(dir, f)) || except.some((e) => inside(f, e)));
  const live = panes();
  return local.find((s) => {
    if (elsewhere(s.folder)) return false;
    const tabs = new Set(s.tabs.map((t) => t.id));
    return live.some((p) => tabs.has(p.tab) && ok(p.cwd));
  });
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
