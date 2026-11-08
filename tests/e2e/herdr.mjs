// End-to-end harness: a real Herdr window with the mods, on the demo (fake
// Jira/GitHub, repos and agent), on its own virtual display. Driven with the
// keyboard (xdotool); checked through herdr-app status, the Work sidebar's
// work.report, git, hc and the demo's state, never by pixels.
//
// Each Herdr gets its own Xvfb display, demo folder, app home and herdr-core
// session, so nothing touches your own Herdr. stop() removes all of it.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const AGENT_STEPS = ["draft-pr", "fix-ci", "address-comments"];
export const root = path.resolve(import.meta.dirname, "../..");
const run = promisify(execFile);
const NEEDS = ["herdr-app", "hc", "Xvfb", "xdotool", "jq", "git"];
// Where failed steps leave a screenshot, the app log, the sidebar's report
// and the demo's state.
export const RESULTS = path.join(root, "e2e-results");

export function missingTools() {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  return NEEDS.filter(
    (t) =>
      !dirs.some((d) => {
        try {
          fs.accessSync(path.join(d, t), fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }),
  );
}

// Polls `check` (sync or async) until it returns something truthy, and returns
// that. Throws after `timeout` ms, saying what it waited for and what it last
// saw.
export async function waitFor(what, check, { timeout = 20_000, every = 250 } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const v = await check();
      if (v) return v;
      last = v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end)
      throw new Error(
        `timed out after ${timeout / 1000}s waiting for ${what}` +
          (last === undefined
            ? ""
            : ` (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`),
      );
    await new Promise((r) => setTimeout(r, every));
  }
}

// A short, unique folder: the app's socket lives in it, and Unix socket
// paths are limited to ~100 bytes.
function shortTmp() {
  const base = os.tmpdir().length <= 40 ? os.tmpdir() : "/tmp";
  return fs.mkdtempSync(path.join(base, "htf-e2e-"));
}

// Starts Xvfb on a free display (it picks one and tells us through fd 3).
async function startXvfb() {
  const x = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "2560x1600x24", "-nolisten", "tcp"], {
    stdio: ["ignore", "ignore", "pipe", "pipe"],
    detached: false,
  });
  let err = "";
  x.stderr.on("data", (d) => (err += d));
  const display = await new Promise((resolve, reject) => {
    let out = "";
    x.stdio[3].on("data", (d) => {
      out += d;
      if (out.includes("\n")) resolve(`:${out.trim()}`);
    });
    x.on("exit", (code) =>
      reject(new Error(`Xvfb exited (${code}): ${err.trim().split("\n").pop()}`)),
    );
    setTimeout(() => reject(new Error("Xvfb didn't start")), 10_000);
  });
  return { proc: x, display };
}

export class Herdr {
  constructor(tracker) {
    this.tracker = tracker;
    this.tmp = shortTmp();
    // The demo names the herdr-core session after this folder.
    this.session = `herdr-demo-${path.basename(this.tmp).replace(/^htf-e2e-/, "e2e-")}`;
    this.demo = path.join(this.tmp, this.session);
    this.home = path.join(this.demo, "app");
    this.logOffset = 0;
    // A stub xdg-open first on the app's PATH: it records the URLs the mods
    // open (see opened()) instead of opening a browser.
    this.bin = path.join(this.tmp, "bin");
    this.openedLog = path.join(this.tmp, "opened.log");
    fs.mkdirSync(this.bin);
    fs.writeFileSync(
      path.join(this.bin, "xdg-open"),
      `#!/bin/sh\nprintf '%s\\n' "$1" >>'${this.openedLog}'\n`,
      { mode: 0o755 },
    );
  }

  // The environment every command gets: this demo's display, app home and
  // core session, and nothing inherited from a Herdr we may be running in.
  get env() {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !/^(HC_|HERDR_|WAYLAND_DISPLAY$|DISPLAY$)/.test(k),
      ),
    );
    return {
      ...env,
      PATH: `${this.bin}${path.delimiter}${env.PATH ?? ""}`,
      DISPLAY: this.display,
      HERDR_DEMO: this.demo,
      HERDR_APP_HOME: this.home,
      HC_SESSION: this.session,
      DEMO_CI_SECONDS: "2",
      GIT_TERMINAL_PROMPT: "0",
    };
  }

  async sh(cmd, args = [], opts = {}) {
    const { stdout } = await run(cmd, args, {
      env: this.env,
      cwd: opts.cwd ?? root,
      maxBuffer: 16 << 20,
      timeout: opts.timeout ?? 30_000,
    });
    return stdout;
  }

  async start() {
    const x = await startXvfb();
    this.xvfb = x.proc;
    this.display = x.display;
    await this.sh(path.join(root, "demo/herdr-demo"), ["--tracker", this.tracker], {
      timeout: 90_000,
    });
    this.window = (
      await this.sh("xdotool", ["search", "--sync", "--name", "^Herdr$"], { timeout: 30_000 })
    )
      .trim()
      .split("\n")[0];
    await waitFor("the Work layout", async () => (await this.status()).layout === "work");
    // Keys only reach the window after a click (focusing it isn't enough
    // without a window manager). The middle of an empty window is safe.
    await this.sh("xdotool", ["windowfocus", "--sync", this.window]);
    await this.sh("xdotool", ["mousemove", "--window", this.window, "700", "600", "click", "1"]);
  }

  async stop() {
    const quiet = (p) => p.catch(() => {});
    if (this.display) {
      // Ends the app and herdr-core of this session only.
      await quiet(this.sh(path.join(root, "demo/herdr-demo"), ["--stop"]));
      await quiet(
        waitFor("the demo's processes to end", () => !this.pids().length, { timeout: 10_000 }),
      );
    }
    this.xvfb?.kill();
    // herdr-core's files for the session (state, sockets).
    const state = path.join(
      process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"),
      "herdr-core",
    );
    fs.rmSync(path.join(state, this.session), { recursive: true, force: true });
    const runtime =
      process.env.XDG_RUNTIME_DIR && path.join(process.env.XDG_RUNTIME_DIR, "herdr-core");
    if (runtime && fs.existsSync(runtime))
      for (const f of fs.readdirSync(runtime))
        if (f === `${this.session}.sock` || f.startsWith(`${this.session}.holder.`))
          fs.rmSync(path.join(runtime, f), { force: true });
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }

  // Live processes of this session (Linux: their environment names it).
  pids() {
    if (!fs.existsSync("/proc/self/environ")) return [];
    return fs.readdirSync("/proc").filter((p) => {
      if (!/^\d+$/.test(p)) return false;
      try {
        return fs
          .readFileSync(`/proc/${p}/environ`, "utf8")
          .split("\0")
          .includes(`HC_SESSION=${this.session}`);
      } catch {
        return false;
      }
    });
  }

  // --- Looking -------------------------------------------------------------

  async status() {
    return JSON.parse(await this.sh("herdr-app", ["status"]));
  }

  // No errors in the app (files and mods) nor from a mod's script since the
  // last call.
  async assertNoErrors(when) {
    const s = await this.status();
    const problems = [...(s.errors ?? []).map((e) => JSON.stringify(e))];
    const log = fs.readFileSync(path.join(this.demo, "app.log"), "utf8");
    const fresh = log.slice(this.logOffset);
    this.logOffset = log.length;
    for (const line of fresh.replace(/\x1b\[[0-9;]*m/g, "").split("\n"))
      if (/ERROR gpui_shell::script/.test(line)) problems.push(line);
    if (problems.length) throw new Error(`errors ${when}:\n  ${problems.join("\n  ")}`);
  }

  async spaces() {
    return JSON.parse(await this.sh("herdr-app", ["ls"])).spaces;
  }

  async spaceAt(folder) {
    return (await this.spaces()).find((s) => s.folder === folder) ?? null;
  }

  // The Work sidebar as it is now (work.report).
  async report() {
    const file = path.join(this.home, "work-report.json");
    const since = Date.now();
    await this.sh("herdr-app", ["do", "work.report"]);
    return waitFor(
      "work.report",
      () => {
        const r = JSON.parse(fs.readFileSync(file, "utf8"));
        return r.at >= since - 5 && r;
      },
      { timeout: 5_000, every: 50 },
    );
  }

  async row(worktree) {
    return (await this.report()).rows.find((r) => r.path === worktree) ?? null;
  }

  // Waits until the sidebar's row for `worktree` satisfies `check`,
  // refreshing it (like ↻) every couple of seconds. Returns the row.
  async waitRow(what, worktree, check, timeout = 30_000) {
    let refreshed = 0;
    return waitFor(
      `${what} (sidebar)`,
      async () => {
        if (Date.now() - refreshed > 2_000) {
          refreshed = Date.now();
          await this.sh("herdr-app", ["do", "work.refresh"]);
        }
        const r = await this.row(worktree);
        return r && check(r) ? r : false;
      },
      { timeout, every: 400 },
    );
  }

  state() {
    return JSON.parse(fs.readFileSync(path.join(this.demo, "state.json"), "utf8"));
  }

  // The demo's open or merged PR for a branch.
  pr(branch) {
    return this.state().prs.findLast((p) => p.branch === branch) ?? null;
  }

  // The URLs opened in the "browser" so far (by the stub xdg-open), oldest first.
  opened() {
    return fs.existsSync(this.openedLog)
      ? fs.readFileSync(this.openedLog, "utf8").split("\n").filter(Boolean)
      : [];
  }

  async screen(terminal) {
    return this.sh("hc", ["read", terminal]);
  }

  async worktrees(repo) {
    return (await this.sh("git", ["-C", repo, "worktree", "list", "--porcelain"]))
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice(9));
  }

  async branchExists(repo, branch) {
    return this.sh("git", [
      "-C",
      repo,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]).then(
      () => true,
      () => false,
    );
  }

  // Saves the window as it is now as a PNG.
  async shot(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await this.sh("herdr-app", ["shot", file]);
    return file;
  }

  // --- Doing ---------------------------------------------------------------

  // The window's size, in px (there's no window manager to refuse it).
  resize(width, height) {
    return this.sh("xdotool", ["windowsize", "--sync", this.window, String(width), String(height)]);
  }

  // Merges `patch` into the app home's settings.json (applied live).
  async settings(patch) {
    const file = path.join(this.home, "settings.json");
    let old = {};
    try {
      old = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    fs.writeFileSync(file, `${JSON.stringify({ ...old, ...patch }, null, 2)}\n`);
  }

  key(...keys) {
    return this.sh("xdotool", ["key", "--delay", "60", ...keys]);
  }

  type(text) {
    return this.sh("xdotool", ["type", "--delay", "40", text]);
  }

  demoCmd(...args) {
    return this.sh(path.join(root, "demo/herdr-demo"), args);
  }

  // Runs the sidebar step `id` on `worktree`'s row with the keys: waits for
  // the row to be selected (it follows the focused space) and to offer the
  // step (an agent step: and to know the space's agent, or the step would
  // start another one), picks it with Alt+Shift+Right, then Alt+Shift+Enter (twice for a
  // step that asks to confirm). Returns once the step has finished.
  async step(worktree, id) {
    const before = await this.waitRow(
      `${worktree} selected, offering ${id}`,
      worktree,
      (r) =>
        r.selected && r.steps.some((s) => s.id === id) && (!AGENT_STEPS.includes(id) || r.agent),
    );
    let row = before;
    for (let i = 0; row.steps[row.step]?.id !== id; i++) {
      if (i > row.steps.length)
        throw new Error(`couldn't pick ${id}: ${JSON.stringify(row.steps)}`);
      await this.key("alt+shift+Right");
      row = await this.row(worktree);
    }
    await this.key("alt+shift+Return");
    if (["finish", "clean-up"].includes(id)) {
      await waitFor(
        `${id} to ask to confirm`,
        async () => (await this.row(worktree))?.confirming === id,
      );
      await this.key("alt+shift+Return");
    }
    // Finished: a newer result than before, or the row is gone (Finish).
    const since = before.last?.at ?? 0;
    return waitFor(`${id} to finish`, async () => {
      const r = await this.row(worktree);
      if (!r) return { gone: true };
      return r.last && r.last.phase !== "running" && (r.last.at ?? 0) > since && r;
    });
  }

  // Saves what's useful after a failure: a screenshot, the app log, the
  // sidebar's report and the demo's state, under e2e-results/<name>-*.
  async saveFailure(name) {
    fs.mkdirSync(RESULTS, { recursive: true });
    const base = path.join(RESULTS, `${this.tracker}-${name.replace(/[^\w-]+/g, "_")}`);
    await this.sh("herdr-app", ["shot", `${base}.png`]).catch(() => {});
    const copy = (from, to) => fs.existsSync(from) && fs.copyFileSync(from, to);
    copy(path.join(this.demo, "app.log"), `${base}-app.log`);
    copy(path.join(this.home, "work-report.json"), `${base}-work-report.json`);
    copy(path.join(this.demo, "state.json"), `${base}-state.json`);
    return base;
  }
}
