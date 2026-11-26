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

// The first element of `kind` in a tree (its recorded data), or null.
export function findKind(node, kind) {
  if (!node || typeof node !== "object") return null;
  if (node.$.kind === kind) return node.$;
  for (const c of node.$.children) {
    const hit = findKind(c, kind);
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
  calls.closed.length = 0;
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
    bind_keys() {},
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
    // Types `value` into the mod's search box (the Input in a fresh render),
    // replacing what was there, as its "change" event does.
    type(value) {
      const state = findKind(render(), "input")?.arg;
      if (!state) throw new Error("no search box");
      state.set_value(value);
      state.handlers.change?.({}, cx);
    },
    // Enter in the search box.
    submit() {
      findKind(render(), "input").arg.handlers.submit?.({}, cx);
    },
    // A key down on the element with `id` (the root by default): key is
    // gpui's name ("down", "backspace", "o"), with `modifiers`.
    key(key, modifiers = {}, id = null) {
      const tree = render();
      const el = id ? find(tree, id) : tree.$;
      el.on.key_down({ key, modifiers: { control: false, ...modifiers } }, cx);
    },
    // Runs the element's on_action(`name`) handler (a key binding's action).
    action(name, id = null) {
      const tree = render();
      const el = id ? find(tree, id) : tree.$;
      const f = el.on[`action:${name}`];
      if (!f) throw new Error(`no action ${name}`);
      f({}, cx);
    },
    // Clicks the element with `id` in a fresh render.
    click(id, handler = "click") {
      const el = find(render(), id);
      if (!el) throw new Error(`nothing to click: ${id}`);
      if (!el.on[handler]) throw new Error(`${id} has no on_${handler}`);
      el.on[handler]({}, cx);
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
