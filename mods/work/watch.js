// Polling helpers, kept out of the views so they can be tested.

// Runs `body(cx, force)` one at a time (through cx.spawn). Asked again while
// running, it runs once more afterwards (forced if any of the requests was),
// rather than dropping it.
export function serial(body) {
  let running = false;
  let queued = null; // null | { force }
  const start = (cx, force = false) => {
    if (running) {
      queued = { force: force || Boolean(queued?.force) };
      return;
    }
    running = true;
    cx.spawn(async (cx) => {
      try {
        await body(cx, force);
      } finally {
        running = false;
        const next = queued;
        queued = null;
        if (next) start(cx, next.force);
      }
    });
  };
  return start;
}

// Lookups by id, each entry { state: "found" | "none" | "failed", value, at }.
// "failed" (the source unreachable) keeps the last good value, so a blip
// doesn't blank what's shown, and is retried after `retryMs`.
export class Cache {
  constructor({ retryMs, now = Date.now }) {
    this.retryMs = retryMs;
    this.now = now;
    this.entries = new Map();
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
      this.now() - entry.at >
        (entry.state === "failed" ? this.retryMs : maxAge)
    );
  }

  // Looks `id` up with `f()`: a value is found, null none, a throw failed.
  async refresh(id, f) {
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
    return this.entries.get(id);
  }
}
