// A throwaway demo (demo/herdr-demo --prepare) for a test file, and helpers.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");

// Creates a demo with the given tracker and points the stub at it. Returns
// its folder.
export function prepare(tracker) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "htf-")), "herdr-demo");
  process.env.HERDR_DEMO = dir;
  process.env.HERDR_APP_HOME = path.join(dir, "app");
  process.env.DEMO_CI_SECONDS = "0";
  execFileSync(path.join(root, "demo/herdr-demo"), ["--prepare", "--tracker", tracker], {
    stdio: "pipe",
  });
  return dir;
}

export const state = () =>
  JSON.parse(fs.readFileSync(path.join(process.env.HERDR_DEMO, "state.json"), "utf8"));
export const writeState = (s) =>
  fs.writeFileSync(path.join(process.env.HERDR_DEMO, "state.json"), JSON.stringify(s));
export const sh = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8" });
export const demoCmd = (...args) => sh(path.join(root, "demo/herdr-demo"), args);
