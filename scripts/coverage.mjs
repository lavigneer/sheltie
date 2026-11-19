// npm run coverage: the unit tests under Node's built-in coverage, reported
// over every file in src. Node only reports files a test loads, and the mod
// entrypoints (src/*/main.js) import Herdr's UI modules, which Node can't
// load; so files missing from Node's report are listed here as 0%.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "sheltie-coverage-"));
const lcov = join(dir, "lcov.info");

const run = spawnSync(
  process.execPath,
  [
    "--import",
    "./tests/register.mjs",
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-include=src/**",
    "--test-reporter=dot",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${lcov}`,
    "tests/*.test.mjs",
  ],
  { cwd: root, stdio: "inherit" },
);

// lcov: per file, LF/LH (lines), BRF/BRH (branches), FNF/FNH (functions).
const covered = new Map();
let file;
for (const line of readFileSync(lcov, "utf8").split("\n")) {
  const [k, v] = line.split(":");
  if (k === "SF") covered.set((file = relative(root, v)), {});
  else if (file && /^(LF|LH|BRF|BRH|FNF|FNH)$/.test(k))
    covered.get(file)[k] = Number(v);
}
rmSync(dir, { recursive: true, force: true });

const srcFiles = readdirSync(join(root, "src"), { recursive: true })
  .filter((f) => f.endsWith(".js"))
  .map((f) => join("src", f))
  .sort();

const lineCount = (f) =>
  readFileSync(join(root, f), "utf8")
    .split("\n")
    .filter((l) => l.trim()).length;
const pct = (hit, all) => (all ? ((100 * hit) / all).toFixed(2) : "100.00");
const total = { LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 };
const rows = srcFiles.map((f) => {
  const c = covered.get(f) ?? { LF: lineCount(f), LH: 0 };
  for (const k in total) total[k] += c[k] ?? 0;
  if (!covered.has(f))
    return [f, pct(0, c.LF), "-", "-", "not loaded by any test"];
  return [f, pct(c.LH, c.LF), pct(c.BRH, c.BRF), pct(c.FNH, c.FNF), ""];
});
rows.push([
  "all files",
  pct(total.LH, total.LF),
  pct(total.BRH, total.BRF),
  pct(total.FNH, total.FNF),
  "",
]);

const head = ["file", "line %", "branch %", "funcs %", ""];
const w = head.map((h, i) =>
  Math.max(h.length, ...rows.map((r) => r[i].length)),
);
const fmt = (r) =>
  r
    .map((c, i) => (i && i < 4 ? c.padStart(w[i]) : c.padEnd(w[i])))
    .join(" | ")
    .trimEnd();
console.log(`\n${fmt(head)}\n${w.map((n) => "-".repeat(n)).join("-|-")}`);
for (const r of rows) console.log(fmt(r));

process.exit(run.status ?? 1);
