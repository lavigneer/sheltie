// scripts/sheltie-watcher.py is stdlib Python; its unittest suite (tests/watcher/)
// runs here so `npm test` covers it.
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("sheltie-watcher (Python unittest)", () => {
  execFileSync(
    "python3",
    [
      "-B",
      "-m",
      "unittest",
      "discover",
      "-s",
      "tests/watcher",
      "-p",
      "test_*.py",
    ],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" },
  );
});
