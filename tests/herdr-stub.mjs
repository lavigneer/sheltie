// A stand-in for Herdr's "herdr" module, enough for the shared code to run in
// Node: exec runs programs for real; the app's live data is empty unless a
// test sets `live`.
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
// The app's spaces and panes, set by a test.
export const live = { spaces: [], panes: [] };
export const panes = () => live.panes;
export const spaces = () => live.spaces;
export const agents = () => [];
export const terminals = () => [];
export const run = () => null;
export const notify = () => "";
