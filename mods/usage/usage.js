// Agent cost and usage, from Claude Code's transcripts: every assistant
// message in <home>/projects/<folder>/**/*.jsonl (subagents too) records its
// model and token usage. Shared by the usage popup and the Work sidebar
// (each row's cost is what was spent by sessions started in its folder).

import { exec, home } from "herdr";
import { C } from "./config.js";

// $ per million tokens: [input, output, cache read]. Cache writes cost 1.25x
// input (5 min) or 2x (1 h); fast mode doubles everything. First party API
// prices; on a subscription they're what the same use would cost on the API.
const PRICES = {
  "claude-fable-5-1": [10, 50, 0.25],
  "claude-mythos-5-1": [10, 50, 0.25],
  "claude-fable-5": [10, 50, 1],
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-opus-5": [5, 25, 0.5],
  "claude-opus-4-8": [5, 25, 0.5],
  "claude-opus-4-7": [5, 25, 0.5],
  "claude-opus-4-6": [5, 25, 0.5],
  "claude-opus-4-5": [5, 25, 0.5],
  "claude-sonnet-5-5": [2, 10, 0.2],
  "claude-sonnet-5": [2, 10, 0.2],
  "claude-sonnet-4-6": [3, 15, 0.3],
  "claude-sonnet-4-5": [3, 15, 0.3],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
  "claude-haiku-4-5": [1, 5, 0.1],
};

// A model id without a date suffix or [1m]-style tag.
const priceOf = (model) =>
  PRICES[model.replace(/\[.*\]$/, "").replace(/-\d{8}$/, "")] ?? null;

// One group's cost in $, or null for a model without a known price.
export function costOf(u) {
  const p = priceOf(u.model);
  if (!p) return null;
  const [inp, out, read] = p;
  const dollars =
    (u.input * inp +
      u.write5m * inp * 1.25 +
      u.write1h * inp * 2 +
      u.read * read +
      u.output * out) /
    1e6;
  return u.fast ? dollars * 2 : dollars;
}

// Claude Code's folder name for a working directory.
export const folderOf = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-");

// Per (folder, UTC day, model): token sums, each message counted once (a
// message is logged once per content block, with the same usage).
const JQ = `
[inputs | index("\t") as $t | (.[:$t] | split("/projects/") | last | split("/") | first) as $f
 | .[$t + 1:] | fromjson? | select(.type == "assistant" and .message.id and .message.usage
   and .message.model and .message.model != "<synthetic>")
 | .message as $m | $m.usage as $u
 | { id: $m.id,
     f: $f,
     d: (.timestamp // "" | .[0:10]),
     m: $m.model,
     fast: ($u.speed == "fast"),
     i: ($u.input_tokens // 0), o: ($u.output_tokens // 0),
     r: ($u.cache_read_input_tokens // 0),
     w5: (if $u.cache_creation then $u.cache_creation.ephemeral_5m_input_tokens // 0
          else $u.cache_creation_input_tokens // 0 end),
     w1: ($u.cache_creation.ephemeral_1h_input_tokens // 0) }]
| unique_by(.id) | group_by([.f, .d, .m, .fast])[]
| { folder: .[0].f, day: .[0].d, model: .[0].m, fast: .[0].fast,
    input: (map(.i) | add), output: (map(.o) | add), read: (map(.r) | add),
    write5m: (map(.w5) | add), write1h: (map(.w1) | add) }`;

const homes = () =>
  C.usage.claudeHomes.map((h) => h.replace(/^~(?=\/|$)/, home()));

// Every group from every Claude home: [{ folder, day, model, fast, input,
// output, read, write5m, write1h, cost }]. Homes without transcripts give
// nothing; a failed jq run throws.
export async function usageGroups() {
  const out = [];
  for (const h of homes()) {
    // awk tags each line with its file (and ends a half-written last line, so
    // it can't run into the next file's first).
    const r = await exec("/bin/sh", [
      "-c",
      'find "$1/projects" -name "*.jsonl" -type f -exec awk \'{ print FILENAME "\\t" $0 }\' {} + | "$2" -R -n -c "$3"',
      "sh",
      h,
      C.programs.jq,
      JQ,
    ]);
    if (r.code !== 0 && !/no such file/i.test(r.stderr ?? ""))
      throw new Error(`usage: ${(r.stderr ?? "").trim().split("\n")[0]}`);
    for (const line of r.stdout.split("\n"))
      if (line) {
        const g = JSON.parse(line);
        out.push({ ...g, cost: costOf(g) });
      }
  }
  return out;
}

// Sums groups: { cost, tokens, unpriced } (unpriced: tokens of models
// without a known price, left out of cost).
export function total(groups) {
  let cost = 0;
  let tokens = 0;
  let unpriced = 0;
  for (const g of groups) {
    const n = g.input + g.output + g.read + g.write5m + g.write1h;
    tokens += n;
    if (g.cost === null) unpriced += n;
    else cost += g.cost;
  }
  return { cost, tokens, unpriced };
}

// The cost spent by sessions started in `dir`, or null with none.
export function costIn(groups, dir) {
  const f = folderOf(dir);
  const mine = groups.filter((g) => g.folder === f);
  return mine.length ? total(mine).cost : null;
}

export const dollars = (n) =>
  n >= 100 ? `$${Math.round(n)}` : n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : "<$0.01";

export const tokenCount = (n) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${Math.round(n / 1e3)}k`
        : String(n);
