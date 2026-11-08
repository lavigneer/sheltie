// A stand-in for Herdr's "herdr" module, enough for the shared code to run in
// Node: exec runs programs for real; the app's live data is empty unless a
// test fills `live`.
import { execFile } from "node:child_process";
import os from "node:os";

export const exec = (cmd, args = [], opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer: 16 << 20, env: process.env },
      (err, stdout, stderr) => {
        if (err && err.code === "ENOENT") return reject(err);
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    ),
  );
export const appHome = () => process.env.HERDR_APP_HOME;
export const home = () => os.homedir();
export const live = { panes: [], spaces: [], agents: [], terminals: [] };
export const panes = () => live.panes;
export const spaces = () => live.spaces;
export const agents = () => live.agents;
export const terminals = () => live.terminals;
export const run = () => null;
export const notify = () => "";
const sharedDoc = new Map();
export const shared = (key) => sharedDoc.get(key);
export const setShared = (key, value) => {
  sharedDoc.set(key, value);
  return null;
};
export const readTextFile = async (path) => {
  const fs = await import("node:fs/promises");
  return fs.readFile(path, "utf8").catch(() => null);
};
export const writeTextFile = async (path, text) => {
  const fs = await import("node:fs/promises");
  await fs.writeFile(path, text);
  return null;
};
