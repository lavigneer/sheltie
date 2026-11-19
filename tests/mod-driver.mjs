// Drives a mod's View the way Herdr does, through the stubs (register.mjs):
// mount it, send it keys (nextCommand), render it and click what it drew,
// then read its text and the run(...)/notify(...) calls it made.
import { calls, useCommands } from "./herdr-stub.mjs";

const WAIT_MS = 5_000;

// The text an element tree shows, one string per child text, in order.
export function texts(node) {
  if (node == null || node === false) return [];
  if (typeof node !== "object") return [String(node)];
  return node.$.children.flatMap(texts);
}

// The element with `id` in a tree (its recorded data: gpui-stub.mjs), or null.
export function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.$.id === id) return node.$;
  for (const c of node.$.children) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
}

// Every element in a tree whose id starts with `prefix`.
export function findAll(node, prefix, out = []) {
  if (!node || typeof node !== "object") return out;
  const $ = node.$;
  if (typeof $.id === "string" && $.id.startsWith(prefix)) out.push($);
  for (const c of $.children) findAll(c, prefix, out);
  return out;
}

// Mounts `ViewClass`. Timers set with cx.timer.after fire (unref'd); repeating
// ones (cx.timer.every) don't, so only keys, clicks and their follow-ups move
// the mod on. Earlier mounts stop getting keys.
export function mount(ViewClass, props = {}) {
  calls.run.length = 0;
  calls.notify.length = 0;
  calls.closeOverlay.length = 0;
  const queue = [];
  let waiting = null; // the mod's pending nextCommand()
  let asked = null; // resolves when the mod next asks for a command
  useCommands(() => {
    asked?.();
    asked = null;
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => {
      waiting = resolve;
    });
  });
  const cx = {
    notifies: 0,
    notify() {
      cx.notifies++;
    },
    stop_propagation() {},
    focus_handle: () => ({}),
    timer: {
      every() {},
      after(ms, f) {
        setTimeout(() => f(cx), ms).unref();
      },
    },
    spawn(f) {
      Promise.resolve()
        .then(() => f(cx))
        .catch((e) => console.error(e));
    },
  };
  const view = new ViewClass();
  view.init(props, cx);
  const render = () => view.render(cx);
  const d = {
    view,
    cx,
    calls,
    render,
    text: () => texts(render()).join(" "),
    // Sends key command `c` (e.g. "next" for work.next) and waits until the
    // mod has handled it.
    press(c) {
      const done = new Promise((resolve) => {
        asked = resolve;
      });
      if (waiting) {
        const w = waiting;
        waiting = null;
        w(c);
      } else queue.push(c);
      return done;
    },
    // Clicks the element with `id` in a fresh render.
    click(id, handler = "click") {
      const el = find(render(), id);
      if (!el) throw new Error(`nothing to click: ${id}`);
      if (!el.on[handler]) throw new Error(`${id} has no on_${handler}`);
      el.on[handler]({}, cx);
    },
    // The state of the first text input it draws (gpui-stub.mjs InputState).
    input() {
      const walk = (n) => {
        if (!n || typeof n !== "object") return null;
        if (n.$.kind === "input") return n.$.arg;
        for (const c of n.$.children) {
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      const state = walk(render());
      if (!state) throw new Error("no text input drawn");
      return state;
    },
    // Sends key `key` (e.g. "down", or "n" with { control: true }) to the
    // element with `id`'s on_key_down.
    key(id, key, modifiers = {}) {
      const el = find(render(), id);
      if (!el?.on.key_down) throw new Error(`${id} has no on_key_down`);
      el.on.key_down({ key, modifiers }, cx);
    },
    // Waits until `test(d)` holds (rendering each try), else fails with `what`.
    async until(test, what = "condition") {
      const end = Date.now() + WAIT_MS;
      for (;;) {
        const got = await test(d);
        if (got) return got;
        if (Date.now() > end)
          throw new Error(`timed out waiting for ${what}; shows: ${d.text()}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
  return d;
}
