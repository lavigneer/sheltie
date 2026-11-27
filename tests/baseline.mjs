// Timing baselines for the scale tests (#371). A test records each phase's
// time (record); the file's last test compares them with the checked-in
// baseline (compare), prints the table either way, and fails when a phase
// took more than SLOWER times its baseline. This catches a slow drift that the
// tests' own budgets (an order of magnitude above, kept as a hard floor)
// would miss.
//
// The baseline comes from CI's machine, whose times the comparison is about:
// copy the JSON that CI's log prints after the table into the baseline file,
// in a PR. PERF_UPDATE=1 (npm run perf:baseline) writes this machine's times
// instead, for trying it locally.
import fs from "node:fs";

export const SLOWER = 2;
// Under a few ms, a timer's noise is the size of the time itself: a phase
// fails only when it is also this much slower than its baseline.
export const NOISE_MS = 5;

/** @type {Map<string, number>} */
const times = new Map();

/** @param {string} phase @param {number} ms */
export const record = (phase, ms) => times.set(phase, ms);

// The phases slower than SLOWER x their baseline (and NOISE_MS more), after
// printing every phase against it. Phases with no baseline yet are listed but
// never fail; nor does a missing baseline file.
/** @param {string} file @returns {string[]} */
export function compare(file) {
  if (process.env.PERF_UPDATE === "1") {
    const out = Object.fromEntries(
      [...times].map(([k, v]) => [k, Math.round(v * 10) / 10]),
    );
    fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`  wrote ${file}`);
    return [];
  }
  /** @type {Record<string, number>} */
  const base = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  const slow = [];
  const width = Math.max(5, ...[...times.keys()].map((k) => k.length));
  console.log(`  ${"phase".padEnd(width)}   baseline        now`);
  for (const [phase, ms] of times) {
    const b = base[phase];
    const over = b !== undefined && ms > SLOWER * b && ms > b + NOISE_MS;
    if (over) slow.push(`${phase}: ${ms.toFixed(1)} ms, baseline ${b} ms`);
    console.log(
      `  ${phase.padEnd(width)} ${(b === undefined ? "-" : `${b} ms`).padStart(10)} ${`${ms.toFixed(1)} ms`.padStart(10)}${over ? `  > ${SLOWER}x` : ""}`,
    );
  }
  // For a baseline refresh: this run's times, as the file takes them.
  console.log(
    `  this run: ${JSON.stringify(Object.fromEntries([...times].map(([k, v]) => [k, Math.round(v * 10) / 10])))}`,
  );
  return slow;
}
