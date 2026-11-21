// Polling helpers, kept out of the views so they can be tested.

// Runs `body(cx, force)` one at a time (through cx.spawn). Asked again while
// running, it runs once more afterwards (forced if any of the requests was),
// rather than dropping it. `start.forcing()`: whether a forced run is running
// or queued (a refresh asked for by hand, which the view shows as loading); it
// notifies when that starts and when it ends.
export function serial(body) {
  let running = false;
  let current = false; // whether the running one is forced
  let queued = null; // null | { force }
  const forcing = () => current || Boolean(queued?.force);
  const run = (cx, force) => {
    running = true;
    current = force;
    cx.spawn(async (cx) => {
      try {
        await body(cx, force);
      } finally {
        running = false;
        current = false;
        const next = queued;
        queued = null;
        if (next) run(cx, next.force);
        if (force && !forcing()) cx.notify?.();
      }
    });
  };
  const start = (cx, force = false) => {
    const was = forcing();
    if (running) queued = { force: force || Boolean(queued?.force) };
    else run(cx, force);
    if (!was && forcing()) cx.notify?.();
  };
  start.forcing = forcing;
  return start;
}

// Lookups by id, each entry { state: "found" | "none" | "failed", value, at }.
// "failed" (the source unreachable) keeps the last good value, so a blip
// doesn't blank what's shown, and is retried after `retryMs`.
// Whether two looked-up values (plain JSON data) are the same.
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

export class Cache {
  constructor({ retryMs, now = Date.now }) {
    this.retryMs = retryMs;
    this.now = now;
    this.entries = new Map();
    // Bumped when an entry's state or value changes (not when a lookup only
    // confirms it), so a view can tell when there is something new to show.
    this.version = 0;
  }

  get(id) {
    return this.entries.get(id);
  }

  // Due when missing, forced, failed a while ago, or older than maxAge.
  due(id, maxAge, { force = false } = {}) {
    const entry = this.entries.get(id);
    return (
      !entry ||
      force ||
      this.now() - entry.at > (entry.state === "failed" ? this.retryMs : maxAge)
    );
  }

  // Looks `id` up with `f()`: a value is found, null none, a throw failed.
  async refresh(id, f) {
    const was = this.entries.get(id);
    try {
      const value = await f();
      this.entries.set(id, {
        state: value ? "found" : "none",
        value,
        at: this.now(),
      });
    } catch {
      this.entries.set(id, {
        state: "failed",
        value: this.entries.get(id)?.value ?? null,
        at: this.now(),
      });
    }
    const now = this.entries.get(id);
    if (!was || was.state !== now.state || !same(was.value, now.value))
      this.version++;
    return now;
  }
}
