// gh quota for work.report (#365, lib.js quota): calls in the last hour, how
// long a rate-limit backoff has lasted, and the diagnostics record made once
// one passes BACKOFF_ALERT_MS. Runs against the fake gh (gh-fault.mjs) with
// Date mocked, so the minutes pass at once. Its own file: lib.js's limits are
// per process, and the other lib tests leave gh backing off.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { faultyGh } from "./gh-fault.mjs";

const { C } = await import("../src/config.js");
const { BACKOFF_ALERT_MS, graphqlQuota, quota, tool } = await import(
  "../src/lib.js"
);
const { DIAGNOSTICS_DIR } = await import("../src/diagnostics.js");

const records = (home) => {
  const dir = path.join(home, DIAGNOSTICS_DIR);
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .map((f) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          } catch {
            return null; // still being written
          }
        })
        .filter(Boolean)
    : [];
};
// recordFailure isn't awaited by lib.js; wait for its file.
const until = async (f) => {
  for (let i = 0; i < 200 && !f(); i++)
    await new Promise((r) => setTimeout(r, 10)); // only Date is mocked
  return f();
};

test("a rate-limit backoff longer than BACKOFF_ALERT_MS is recorded once, and shows in quota()", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sheltie-quota-"));
  process.env.HERDR_APP_HOME = home;
  const { gh, faults } = faultyGh();
  const was = C.programs.gh;
  C.programs.gh = gh;
  mock.timers.enable({ apis: ["Date"], now: 1_000_000_000_000 });
  try {
    assert.equal((await tool("gh", ["api", "a"])).code, 0);
    assert.deepEqual(quota().gh, {
      callsLastHour: 1,
      backingOff: false,
      backoffMs: 0,
      alert: false,
    });

    // GitHub starts refusing: the backoff begins, but it's no alert yet.
    faults({ rateLimited: true });
    assert.equal((await tool("gh", ["api", "b"])).code, 1);
    let q = quota().gh;
    assert.equal(q.backingOff, true);
    assert.equal(q.callsLastHour, 2);
    assert.equal(q.alert, false);
    assert.deepEqual(records(home), []);

    // Past the first minute GitHub still refuses (the backoff doubles)...
    mock.timers.tick(61_000);
    assert.equal((await tool("gh", ["api", "c"])).code, 1);
    assert.deepEqual(records(home), []);
    // ...and past BACKOFF_ALERT_MS a refused background call records it.
    mock.timers.tick(BACKOFF_ALERT_MS);
    assert.equal((await tool("gh", ["api", "d"])).code, 1);
    q = quota().gh;
    assert.equal(q.alert, true);
    assert.ok(q.backoffMs > BACKOFF_ALERT_MS);
    assert.ok(await until(() => records(home).length === 1));
    const [r] = records(home);
    assert.equal(r.what, "gh rate-limit backoff");
    assert.equal(r.context.program, "gh");
    assert.ok(r.context.backoffMs > BACKOFF_ALERT_MS);

    // Only once per backoff.
    await tool("gh", ["api", "e"]);
    await new Promise((r) => setImmediate(r));
    assert.equal(records(home).length, 1);

    // A call that works ends it; an hour on, the calls have aged out.
    faults({});
    assert.equal((await tool("gh", ["api", "f"], { urgent: true })).code, 0);
    assert.equal(quota().gh.backoffMs, 0);
    assert.equal(quota().gh.alert, false);
    mock.timers.tick(60 * 60_000);
    assert.equal(quota().gh.callsLastHour, 0);
  } finally {
    mock.timers.reset();
    C.programs.gh = was;
  }
});

test("graphqlQuota: GitHub's GraphQL points from gh api rate_limit, or null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sheltie-quota-"));
  const gh = path.join(dir, "gh");
  const was = C.programs.gh;
  C.programs.gh = gh;
  try {
    fs.writeFileSync(
      gh,
      `#!/bin/sh
[ "$1 $2 $3 $4" = "api rate_limit --jq .resources.graphql" ] || exit 2
echo '{"limit":5000,"used":120,"remaining":4880,"reset":1700000000}'`,
    );
    fs.chmodSync(gh, 0o755);
    assert.deepEqual(await graphqlQuota(), {
      limit: 5000,
      used: 120,
      remaining: 4880,
      reset: 1700000000,
    });
    fs.writeFileSync(gh, "#!/bin/sh\necho 'HTTP 502' >&2; exit 1");
    assert.equal(await graphqlQuota(), null);
  } finally {
    C.programs.gh = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
