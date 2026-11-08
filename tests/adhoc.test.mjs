// Ad-hoc work: a branch named after what it is, no ticket needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./herdr-stub.mjs";

const { useConfig } = await import("../src/config.js");
const { adhocBranch } = await import("../src/data.js");

test("adhocBranch: a kebab-case slug in C.branch", () => {
  useConfig({ branch: "me/{ref}" });
  assert.equal(adhocBranch("  Fix the login page!  "), "me/fix-the-login-page");
  assert.equal(adhocBranch("x".repeat(60)), `me/${"x".repeat(40)}`);
  assert.equal(adhocBranch("Bump deps ".repeat(10)).endsWith("-"), false);
  useConfig({});
  assert.equal(adhocBranch("Tidy README"), "tidy-readme");
});

test("adhocBranch: nothing usable, no branch", () => {
  assert.equal(adhocBranch("   "), null);
  assert.equal(adhocBranch("🙂 ✨"), null);
});
