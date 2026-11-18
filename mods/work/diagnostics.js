// Failures, kept for bug reports: each one is a JSON file in
// <app home>/sheltie-diagnostics/ (<time>-<mod>.json), the newest KEEP kept.
// diagnostics.sh bundles them with versions, settings and the app log.
// Recording never throws: a failure to record is only logged.

import { appHome, exec, writeTextFile } from "herdr";

export const DIAGNOSTICS_DIR = "sheltie-diagnostics";
export const KEEP = 50;

let seq = 0;

// console isn't in the es2022 lib the type check uses; Herdr has it.
const logError = (m) => /** @type {any} */ (globalThis).console?.error(m);

/**
 * Records a failure. It doesn't log it: callers that logged before still do
 * (the e2e tests treat logged errors as bugs, and a refused step isn't one).
 * @param {string} mod  the mod, or mod.command (e.g. "work.start")
 * @param {string} what what was being done ("Finish", "load tickets", ...)
 * @param {unknown} error
 * @param {Record<string, unknown>} [context] anything else that helps (paths, keys)
 */
export async function recordFailure(mod, what, error, context = {}) {
  const message = `${/** @type {any} */ (error)?.message ?? error}`;
  const app = appHome();
  if (!app) return;
  try {
    const dir = `${app}/${DIAGNOSTICS_DIR}`;
    const at = new Date();
    const name = `${at.toISOString().replace(/[:.]/g, "-")}-${seq++}-${mod.replace(/[^\w.-]/g, "_")}.json`;
    const record = {
      at: at.toISOString(),
      mod,
      what,
      message,
      stack: /** @type {any} */ (error)?.stack ?? null,
      context,
    };
    await exec("mkdir", ["-p", dir]);
    await writeTextFile(
      `${dir}/${name}`,
      `${JSON.stringify(record, null, 2)}\n`,
      null,
    );
    await prune(dir);
  } catch (e) {
    logError(`diagnostics: couldn't record: ${e?.message ?? e}`);
  }
}

// Removes all but the newest KEEP records (names sort by time).
async function prune(dir) {
  const ls = await exec("ls", ["-1", dir]);
  const old = ls.stdout
    .split("\n")
    .filter((f) => f.endsWith(".json"))
    .sort()
    .slice(0, -KEEP);
  if (old.length) await exec("rm", ["-f", ...old.map((f) => `${dir}/${f}`)]);
}
