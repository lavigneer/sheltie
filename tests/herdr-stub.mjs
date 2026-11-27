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
// What the mod asked Herdr to do: run(name, args) and notify(note) calls.
export const calls = { run: [], notify: [], closed: [] };
export const run = (name, args) => {
  calls.run.push({ name, args });
  return null;
};
// The focused pane (live.focused), the mod's props and closing its overlay.
export const focused = () => live.focused ?? null;
export const props = () => ({ overlay: "overlay-1" });
export const closeOverlay = (id) => {
  calls.closed.push(id);
  return null;
};
export const notify = (note) => {
  calls.notify.push(note);
  return "";
};
// Every theme colour is its own name, so tests can tell which one was used.
export const theme = () =>
  new Proxy({}, { get: (_t, k) => (typeof k === "string" ? k : undefined) });
// Commands (keys) for nextCommand(): a test sets where they come from.
let commands = () => new Promise(() => {});
export const nextCommand = () => commands();
export const useCommands = (next) => {
  commands = next;
};
const sharedDoc = new Map();
export const shared = (key) => sharedDoc.get(key);
export const setShared = (key, value) => {
  sharedDoc.set(key, value);
  return null;
};
// Like Herdr's: null for an absent file, a rejection for any other failure.
export const readTextFile = async (path) => {
  const fs = await import("node:fs/promises");
  return fs.readFile(path, "utf8").catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
};
export const writeTextFile = async (path, text) => {
  const fs = await import("node:fs/promises");
  await fs.writeFile(path, text);
  return null;
};
