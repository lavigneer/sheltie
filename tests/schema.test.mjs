// sheltie.schema.json is built from types/settings.d.ts (npm run build; CI
// checks it's current): config.example.json uses only settings it knows.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const read = (f) =>
  JSON.parse(fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
const schema = read("sheltie.schema.json");
const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

test("config.example.json sets only settings the schema has", () => {
  const known = (node, value, at) => {
    if (!isObject(value) || !node.properties) return;
    for (const [k, v] of Object.entries(value)) {
      assert.ok(node.properties[k], `${at}.${k}: not in the schema`);
      known(node.properties[k], v, `${at}.${k}`);
    }
  };
  known(schema, read("config.example.json"), "example");
});

test("a repo file's $schema isn't reported as a setting that doesn't apply", async () => {
  const { repoSettings } = await import("../src/config.js");
  const r = repoSettings({ $schema: "x", tracker: "github" }, ".sheltie.json");
  assert.equal(r.problem, null);
  assert.equal(r.settings?.tracker, "github");
});
