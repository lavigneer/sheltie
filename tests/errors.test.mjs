import assert from "node:assert/strict";
import { test } from "node:test";

const { errorMessage, errorText } = await import("../src/errors.js");

test("errorMessage: an Error's message, or whatever else was thrown", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("plain string"), "plain string");
  assert.equal(errorMessage({ message: "from an object" }), "from an object");
});

test("errorMessage: never throws, even for null or undefined", () => {
  assert.equal(errorMessage(null), "null");
  assert.equal(errorMessage(undefined), "undefined");
});

test("errorText: the first line only, or a fallback when empty", () => {
  assert.equal(errorText(new Error("first\nsecond")), "first");
  assert.equal(errorText("  padded  "), "padded");
  assert.equal(errorText(""), "Something went wrong");
  assert.equal(errorText(null), "null");
});
