// Settings: <Herdr app home>/sheltie.json, merged over the defaults (src/defaults.js).
// Every mod awaits configReady() before using them; `C` holds the result.
// What each setting does: types/settings.d.ts (and sheltie.schema.json, made
// from it); the defaults: src/defaults.js.

import { appHome, exec, home } from "herdr";
import { DEFAULTS } from "./defaults.js";

export { DEFAULTS };

/** The settings in use, or a repo's (repoSettings). @typedef {import("../types/settings.js").Settings & { problem?: string | null }} Settings */

export const SETTINGS_FILE = "sheltie.json";

// The settings in use. Filled in by configReady(); tests may set them with
// useConfig().
/** @type {Settings} */
export const C = JSON.parse(JSON.stringify(DEFAULTS));

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

// `over` merged into `base`: objects key by key, everything else replaced.
export function merge(base, over) {
  if (!isObject(base) || !isObject(over))
    return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

let loading = null;

// Loads the settings once (later calls wait for the same load). A missing file
// means defaults; an unreadable or invalid one also means defaults, and
// `C.problem` says why, for the mods to show.
export function configReady() {
  loading ??= load();
  return loading;
}

async function load() {
  const { over, problem } = await readSettings(`${appHome()}/${SETTINGS_FILE}`);
  const settings = merge(DEFAULTS, over);
  settings.programs = await resolvePrograms(settings.programs);
  useConfig(settings, problem);
}

// A settings file: { over (its JSON object, {} if missing or bad), problem }.
/** @param {string} path @returns {Promise<{ over: Record<string, any>, problem: string | null }>} */
export async function readSettings(path) {
  const r = await exec("cat", [path]).catch((e) => ({
    code: 1,
    stdout: "",
    stderr: `${e}`,
  }));
  if (r.code !== 0)
    return {
      over: {},
      problem: /no such file/i.test(r.stderr ?? "")
        ? null
        : `couldn't read ${path}: ${(r.stderr ?? "").trim()}`,
    };
  try {
    const over = JSON.parse(r.stdout);
    if (!isObject(over)) throw new Error("not a JSON object");
    return { over, problem: null };
  } catch (e) {
    return {
      over: {},
      problem: `${path}: ${e.message ?? e}; using the defaults`,
    };
  }
}

// A repo's own settings: REPO_FILE in its main checkout, merged over the
// global ones. Only REPO_SETTINGS apply there: where its tickets come from,
// its branch names and its PR workflow.
export const REPO_FILE = ".sheltie.json";
export const REPO_SETTINGS = [
  "tracker",
  "jira",
  "github",
  "branch",
  "workflow",
];

// The settings for a repo whose REPO_FILE holds `over`, or null when it sets
// none of REPO_SETTINGS (the global ones apply). `problem` names keys that
// don't apply in a repo.
export function repoSettings(over, path) {
  const picked = Object.fromEntries(
    REPO_SETTINGS.filter((k) => k in over).map((k) => [k, over[k]]),
  );
  const ignored = Object.keys(over).filter(
    (k) => k !== "$schema" && !REPO_SETTINGS.includes(k),
  );
  return {
    settings: Object.keys(picked).length ? merge(C, picked) : null,
    problem: ignored.length
      ? `${path}: ${ignored.join(", ")} can only be set in ${SETTINGS_FILE}`
      : null,
  };
}

// The settings for work in `repo` (from localRepos): its own, or the global ones.
/** @param {import("./types.js").Repo | null | undefined} repo @returns {Settings} */
export const settingsOf = (repo) => repo?.settings ?? C;

// Replaces the settings in use (for tests, and after loading).
/** @param {Settings} settings @param {string | null} [problem] */
export function useConfig(settings, problem = null) {
  for (const k of Object.keys(C)) delete C[k];
  Object.assign(C, merge(DEFAULTS, settings), { problem });
  C.roots = C.roots.map(expandHome);
}

const expandHome = (p) => p.replace(/^~(?=\/|$)/, home());

// Program names to absolute paths via your login shell, which has the PATH a
// terminal would (an app started from a launcher may not). Absolute paths and
// names not found are kept as given.
async function resolvePrograms(programs) {
  const names = Object.values(programs).filter((p) => !p.startsWith("/"));
  if (!names.length) return programs;
  const script =
    'for p in "$@"; do printf "%s=%s\\n" "$p" "$(command -v "$p")"; done';
  const r = await exec("/bin/sh", [
    "-c",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template.
    '"${SHELL:-/bin/sh}" -lc "$0" sh "$@"',
    script,
    ...names,
  ]).catch(() => null);
  const found = new Map();
  for (const line of r?.stdout.split("\n") ?? []) {
    const i = line.indexOf("=");
    if (i > 0) found.set(line.slice(0, i), line.slice(i + 1));
  }
  return Object.fromEntries(
    Object.entries(programs).map(([k, p]) => [
      k,
      p.startsWith("/") ? p : found.get(p)?.startsWith("/") ? found.get(p) : p,
    ]),
  );
}
