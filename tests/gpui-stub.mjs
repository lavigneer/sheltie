// A stand-in for Herdr's "gpui-base" and "gpui-kit" modules: elements record
// what a mod builds, under `$` (its id, children, on_* handlers and the last
// value of each style call), so tests can read the text it renders and click
// what it draws.

// An element: every builder call returns it. `child`/`children` add children,
// `on_*` keep handlers, `when(cond, f)` applies f when cond, and Popover's
// `trigger`/`content` count as children. Anything else is kept in `style`.
export function element(kind, arg) {
  const node = { kind, arg, id: null, children: [], on: {}, style: {} };
  const self = new Proxy(node, {
    get(_target, name) {
      if (name === "$") return node;
      if (typeof name === "symbol" || name === "then") return undefined;
      return (...args) => {
        if (name === "id") node.id = args[0];
        else if (name === "child" || name === "trigger" || name === "content")
          node.children.push(args[0]);
        else if (name === "children") node.children.push(...args[0]);
        else if (name === "when") return args[0] ? args[1](self) : self;
        else if (name.startsWith("on_")) node.on[name.slice(3)] = args[0];
        else node.style[name] = args.length > 1 ? args : args[0];
        return self;
      };
    },
  });
  return self;
}

export const div = () => element("div");
export const svg = (path) => element("svg", path);
export const h_flex = () => element("h_flex");
export const v_flex = () => element("v_flex");
export const Popover = { new: (id) => element("popover").id(id) };
export class View {}

// A text input's state. Tests type into it (`type`) and press Enter
// (`submit`), which fire the listeners the mod set with `on`.
export const InputState = {
  new(opts = {}) {
    let text = "";
    const on = {};
    const cx = { notify() {}, stop_propagation() {} };
    return {
      opts,
      focused: false,
      value: () => text,
      focus() {
        this.focused = true;
      },
      on(event, f) {
        on[event] = f;
      },
      type(s) {
        text = s;
        on.change?.({}, cx);
      },
      submit() {
        on.submit?.({}, cx);
      },
    };
  },
};
// The input drawn for an InputState: its `arg` is that state.
export const Input = { new: (state) => element("input", state) };
