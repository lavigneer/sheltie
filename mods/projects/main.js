// Projects: a sessionizer for the Herdr app.
//
// Lists the git repos under the configured roots (settings: roots, depth),
// filtered as you type. Enter goes to the space already open on that repo (its
// main checkout, not one of its worktrees, which live inside it), or
// opens a new space there. Opened with mod.open:projects (prefix+f).
//
// Keys: type to filter, Up/Down or Ctrl+N/Ctrl+P to move, Enter to open, Esc to close.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, home, run, theme, props, closeOverlay } from "herdr";
import { C, configReady } from "./config.js";
import { basename, pool, score, spaceFor, moveKey } from "./lib.js";
import { hubExcept, listWorktrees } from "./data.js";

// Repos at exactly DEPTH below a root: <root>/<repo>/.git (a dir, or a file for
// worktrees). Returns { repos, problems }: a root that couldn't be read (missing,
// no permission) is a problem to show, not just "no repos".
async function scan() {
  const found = new Set();
  const problems = [];
  await configReady();
  for (const root of C.roots) {
    const depth = String(C.depth + 1);
    try {
      const r = await exec("find", [
        root,
        "-mindepth",
        depth,
        "-maxdepth",
        depth,
        "-name",
        ".git",
        "-prune",
      ]);
      for (const line of r.stdout.split("\n")) {
        if (line.endsWith("/.git")) found.add(line.slice(0, -"/.git".length));
      }
      if (r.code !== 0)
        problems.push(
          (r.stderr || "").trim().split("\n")[0] || `couldn't read ${root}`,
        );
    } catch (e) {
      problems.push(`couldn't scan ${root}: ${e?.message ?? e}`);
    }
  }
  return {
    repos: [...found].sort((a, b) => basename(a).localeCompare(basename(b))),
    problems,
  };
}

export default class Projects extends View {
  init(_props, cx) {
    this.filter = "";
    this.at = 0;
    this.repos = null; // null while the first scan runs
    this.linked = new Map(); // repo path -> its worktrees' paths
    this.problems = [];
    this.input = InputState.new({ placeholder: "Open a project…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", () => this.go(this.rows()[this.at]));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      const { repos, problems } = await scan();
      this.repos = repos;
      this.problems = problems;
      cx.notify();
      // Each repo's worktrees, to tell its own space from theirs.
      await pool(
        repos.map((path) => async () => {
          const { linked } = await listWorktrees(path);
          this.linked.set(
            path,
            linked.map((w) => w.path),
          );
        }),
      );
      cx.notify();
    });
  }

  // The space open on repo `path` (its main checkout), not one of its
  // worktrees' (they live inside it). Until its worktrees are listed, only
  // C.worktreeDir is left out.
  spaceAt(path) {
    return spaceFor(path, hubExcept(path, this.linked.get(path) ?? []));
  }

  // Not named close(): Herdr calls a View's close() itself when the overlay goes.
  dismiss() {
    closeOverlay(props().overlay);
  }

  rows() {
    const rows = [];
    for (const path of this.repos ?? []) {
      const name = basename(path);
      const s = score(name, this.filter) ?? score(path, this.filter);
      if (s === null) continue;
      rows.push({ path, name, score: s, space: this.spaceAt(path) });
    }
    // Best match first; among equals, repos with an open space, then by name.
    rows.sort(
      (a, b) =>
        a.score - b.score ||
        Boolean(b.space) - Boolean(a.space) ||
        a.name.localeCompare(b.name),
    );
    return rows;
  }

  go(r) {
    if (!r) return;
    this.dismiss();
    const open = this.spaceAt(r.path);
    if (open) run("space.select", { id: open.id });
    else run("space.new", { name: r.name, folder: r.path });
  }

  render() {
    const t = theme();
    const rows = this.rows();
    this.at = Math.max(0, Math.min(this.at, rows.length - 1));
    const sel = rows[this.at];
    const tilde = (p) =>
      p.startsWith(home()) ? "~" + p.slice(home().length) : p;

    const row = (r) =>
      h_flex()
        .id(`pj-${r.path}`)
        .mx(4)
        .px(10)
        .h(32)
        .rounded(7)
        .gap(10)
        .items_center()
        .cursor_pointer()
        .when(r === sel, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.go(r))
        .child(
          div()
            .w(12)
            .flex_none()
            .text_color(r.space ? t.accent : t.dim)
            .child(r.space ? "●" : "·"),
        )
        .child(
          div()
            .flex_shrink(1)
            .min_w(80)
            .truncate()
            .text_color(t.foreground)
            .when(Boolean(r.space?.active), (d) => d.font_semibold())
            .child(r.name),
        )
        .child(
          div()
            .flex_1()
            .min_w(80)
            .truncate()
            .text_size(11)
            .text_color(t.dim)
            .child(tilde(r.path)),
        )
        .when(Boolean(r.space), (el) =>
          el.child(
            div().flex_none().text_size(11).text_color(t.dim).child("open"),
          ),
        );

    const problem = this.problems[0] ? tilde(this.problems[0]) : null;
    const empty =
      this.repos === null
        ? "Scanning…"
        : rows.length
          ? problem
          : this.repos.length
            ? "No matching project"
            : (problem ?? `No git repos in ${C.roots.map(tilde).join(", ")}`);

    return v_flex()
      .id("projects")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        if (!moveKey(e, this, rows.length, () => this.dismiss())) return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .items_center()
          .child(
            div()
              .flex_1()
              .text_size(15)
              .font_semibold()
              .text_color(t.foreground)
              .child("Projects"),
          )
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .rounded(9)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .child(
            svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim),
          )
          .child(
            Input.new(this.input)
              .flex_1()
              .h_full()
              .text_size(12.8)
              .text_color(t.foreground),
          ),
      )
      .child(
        empty
          ? div().px(10).py(8).text_color(t.dim).child(empty)
          : v_flex()
              .h(Math.min(420, 6 + rows.length * 32))
              .min_h(0)
              .flex_shrink(1)
              .pb(6)
              .overflow_y_scrollbar()
              .children(rows.map(row)),
      );
  }
}
