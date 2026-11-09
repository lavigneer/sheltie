import assert from "node:assert/strict";
import { test } from "node:test";
import { requested, ticketNamed } from "../src/start.js";

test("requested takes keys or { ticket, repo }", () => {
  assert.deepEqual(
    requested({ tickets: ["WEB-1", { ticket: " #2 ", repo: "acme/web" }] }),
    [
      { ticket: "WEB-1", repo: null },
      { ticket: "#2", repo: "acme/web" },
    ],
  );
  assert.throws(() => requested({}), /expected/);
  assert.throws(() => requested({ tickets: [{ repo: "x" }] }), /not a ticket/);
});

test("ticketNamed matches a key, or a label only when it's unique", () => {
  const a = { key: "acme/web#12", label: "web#12" };
  const b = { key: "acme/api#12", label: "#12" };
  const c = { key: "other/api#12", label: "#12" };
  assert.equal(ticketNamed("ACME/WEB#12", [a, b]), a);
  assert.equal(ticketNamed("web#12", [a, b]), a);
  assert.equal(ticketNamed("#12", [a, b]), b);
  assert.equal(ticketNamed("#12", [a, b, c]), null);
  assert.equal(ticketNamed("WEB-9", [a]), null);
});

test("drainRequests handles each request once and leaves its result", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { drainRequests } = await import("../src/start.js");
  const dir = fs.mkdtempSync(`${os.tmpdir()}/work-start-`);
  fs.writeFileSync(`${dir}/a.json`, '{"tickets":["WEB-1"]}');
  fs.writeFileSync(`${dir}/b.json`, "not json");
  fs.writeFileSync(`${dir}/c.json.tmp`, "{}"); // still being written
  fs.writeFileSync(`${dir}/old.result.json`, "{}");
  const old = new Date(Date.now() - 2 * 86_400_000);
  fs.utimesSync(`${dir}/old.result.json`, old, old);
  const seen = [];
  await drainRequests(dir, async (r) => {
    seen.push(r);
    return [{ ticket: "WEB-1", status: "started" }];
  });
  assert.deepEqual(seen, [{ tickets: ["WEB-1"] }]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    "a.result.json",
    "b.result.json",
    "c.json.tmp",
  ]);
  const a = JSON.parse(fs.readFileSync(`${dir}/a.result.json`, "utf8"));
  assert.deepEqual(a.results, [{ ticket: "WEB-1", status: "started" }]);
  const b = JSON.parse(fs.readFileSync(`${dir}/b.result.json`, "utf8"));
  assert.match(b.error, /JSON/);
  fs.rmSync(dir, { recursive: true });
});

test("drainRequests handles requests oldest first", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { drainRequests } = await import("../src/start.js");
  const dir = fs.mkdtempSync(`${os.tmpdir()}/work-start-`);
  const now = Date.now() / 1000;
  ["b", "c", "a"].forEach((id, i) => {
    fs.writeFileSync(`${dir}/${id}.json`, JSON.stringify(id));
    fs.utimesSync(`${dir}/${id}.json`, now - 60 + i, now - 60 + i);
  });
  const seen = [];
  await drainRequests(dir, async (r) => {
    seen.push(r);
    return [];
  });
  assert.deepEqual(seen, ["b", "c", "a"]);
  fs.rmSync(dir, { recursive: true });
});
