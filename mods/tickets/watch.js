// Polling helpers, kept out of the views so they can be tested.

// The states of serial() name what runs and what waits behind it:
const IDLE = "idle"; // nothing
const RUN = "run"; // an unforced run
const RUN_QUEUED = "run, queued"; // ... and an unforced run waits
const RUN_FORCED = "run, forced queued"; // ... and a forced run waits
const FORCED = "forced"; // a forced run
const FORCED_QUEUED = "forced, queued"; // ... and an unforced run waits
const FORCED_FORCED = "forced, forced queued"; // ... and a forced run waits
// Forcing: a forced run is running or waiting (what `start.forcing()` reads).
const FORCING = new Set([RUN_FORCED, FORCED, FORCED_QUEUED, FORCED_FORCED]);
// The running run is forced (so the body is called with force).
const FORCED_RUN = new Set([FORCED, FORCED_QUEUED, FORCED_FORCED]);
// The state after a request (keyed by whether it is `plain` or `forced`).
/** @type {Record<string, { plain: string, forced: string }>} */
const ON_REQUEST = {
  [IDLE]: { plain: RUN, forced: FORCED },
  [RUN]: { plain: RUN_QUEUED, forced: RUN_FORCED },
  [RUN_QUEUED]: { plain: RUN_QUEUED, forced: RUN_FORCED },
  [RUN_FORCED]: { plain: RUN_FORCED, forced: RUN_FORCED },
  [FORCED]: { plain: FORCED_QUEUED, forced: FORCED_FORCED },
  [FORCED_QUEUED]: { plain: FORCED_QUEUED, forced: FORCED_FORCED },
  [FORCED_FORCED]: { plain: FORCED_FORCED, forced: FORCED_FORCED },
};
// The state once the running run ends: the waiting run (if any) is now running.
/** @type {Record<string, string>} */
const ON_FINISH = {
  [RUN]: IDLE,
  [RUN_QUEUED]: RUN,
  [RUN_FORCED]: FORCED,
  [FORCED]: IDLE,
  [FORCED_QUEUED]: RUN,
  [FORCED_FORCED]: FORCED,
};

// Runs `body(cx, force)` one at a time (through cx.spawn). Asked again while
// running, it runs once more afterwards (forced if any of the requests was),
// rather than dropping it. `start.forcing()`: whether a forced run is running
// or queued (a refresh asked for by hand, which the view shows as loading); it
// notifies when that starts and when it ends.
/** @param {(cx: any, force: boolean) => any} body */
export function serial(body) {
  let state = IDLE;
  const forcing = () => FORCING.has(state);
  /** @param {any} cx */
  const run = (cx) => {
    const force = FORCED_RUN.has(state);
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        await body(cx, force);
      } finally {
        const was = forcing();
        state = ON_FINISH[state];
        if (state !== IDLE) run(cx);
        if (was && !forcing()) cx.notify?.();
      }
    });
  };
  /** @param {any} cx @param {boolean} [force] */
  const start = (cx, force = false) => {
    const was = forcing();
    const idle = state === IDLE;
    state = ON_REQUEST[state][force ? "forced" : "plain"];
    if (idle) run(cx);
    if (!was && forcing()) cx.notify?.();
  };
  start.forcing = forcing;
  return start;
}

// Lookups by id, each entry { state: "found" | "none" | "failed", value, at }.
// "failed" (the source unreachable) keeps the last good value, so a blip
// doesn't blank what's shown, and is retried after `retryMs`.
// Whether two looked-up values (plain JSON data) are the same.
/** @param {unknown} a @param {unknown} b */
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

export class Cache {
  /** @param {{ retryMs: number, now?: () => number }} opts */
  constructor({ retryMs, now = Date.now }) {
    this.retryMs = retryMs;
    this.now = now;
    this.entries = new Map();
    // Bumped when an entry's state or value changes (not when a lookup only
    // confirms it), so a view can tell when there is something new to show.
    this.version = 0;
  }

  /** @param {string} id */
  get(id) {
    return this.entries.get(id);
  }

  // Due when missing, forced, failed a while ago, or older than maxAge.
  /** @param {string} id @param {number} maxAge @param {{ force?: boolean }} [opts] */
  due(id, maxAge, { force = false } = {}) {
    const entry = this.entries.get(id);
    return (
      !entry ||
      force ||
      this.now() - entry.at > (entry.state === "failed" ? this.retryMs : maxAge)
    );
  }

  // Looks `id` up with `f()`: a value is found, null none, a throw failed.
  /** @param {string} id @param {() => any} f */
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
