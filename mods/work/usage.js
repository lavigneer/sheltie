// Agent cost and usage, from the agents' own session logs, priced with
// LiteLLM's model price list. Shared by the Usage sidebar and the Work sidebar
// (each row's cost is what was spent working in its folder).
//
// Agents (settings: usage.agents):
//   claude-code  <home>/projects/**/*.jsonl: each assistant message has its
//                model, usage and the cwd it ran in; a message is logged once
//                per content block, so it's counted by id.
//   codex        <home>/sessions/**/*.jsonl: session_meta / turn_context set
//                the cwd and model; each token_count event's last_token_usage
//                is one model call (input_tokens includes cached ones). An
//                event repeating the same total is not a new call.
//   opencode     <home>/opencode.db (sqlite3): each assistant row of the
//                message table has its modelID, tokens and path.cwd;
//                reasoning tokens are billed as output.
//
// Prices (settings: usage.prices) are downloaded to <app home>/usage-prices.json
// when newer, at most hourly; offline, the last download is used. A model
// without a price shows its tokens but no cost.

import { appHome, exec, home } from "herdr";
import { C } from "./config.js";

const PRICES_MS = 3_600_000;

// Per (agent, cwd, UTC day, model, fast) token sums, from lines tagged
// "<file>\t<json>" (see scan()).
const GROUP = `
| group_by([.d, .m, .fast, .dir])[]
| { dir: .[0].dir, day: .[0].d, model: .[0].m, fast: .[0].fast,
    input: (map(.i) | add), output: (map(.o) | add), read: (map(.r) | add),
    write5m: (map(.w5) | add), write1h: (map(.w1) | add) }`;

// Shell scripts printing an agent's records for jq, given $1 = its home and
// $2 = sqlite3. A missing folder or database (agent never used) prints none.
// JSONL: awk tags each line with its file and ends a half-written last line,
// so it can't run into the next file's first.
const JSONL = (dir) =>
  `[ -d "$1/${dir}" ] || exit 0; find "$1/${dir}" -name "*.jsonl" -type f -exec awk '{ print FILENAME "\\t" $0 }' {} +`;

const READERS = {
  "claude-code": {
    source: JSONL("projects"),
    jq: `
[inputs | index("\\t") as $t | .[$t + 1:] | fromjson?
 | select(.type == "assistant" and .message.id and .message.usage
     and .message.model and .message.model != "<synthetic>")
 | .message as $m | $m.usage as $u
 | { id: $m.id, dir: (.cwd // ""), d: (.timestamp // "" | .[0:10]), m: $m.model,
     fast: ($u.speed == "fast"),
     i: ($u.input_tokens // 0), o: ($u.output_tokens // 0),
     r: ($u.cache_read_input_tokens // 0),
     w5: (if $u.cache_creation then $u.cache_creation.ephemeral_5m_input_tokens // 0
          else $u.cache_creation_input_tokens // 0 end),
     w1: ($u.cache_creation.ephemeral_1h_input_tokens // 0) }]
| unique_by(.id) ${GROUP}`,
  },
  codex: {
    source: JSONL("sessions"),
    jq: `
[foreach (inputs | index("\\t") as $t
          | { f: .[:$t], j: (.[$t + 1:] | fromjson? // null) } | select(.j)) as $x
  ({};
   (if $x.f != .f then { f: $x.f } else . end) as $s
   | $x.j as $j | $j.payload as $p
   | if $j.type == "session_meta" then $s + { cwd: ($p.cwd // $s.cwd), out: null }
     elif $j.type == "turn_context" then
       $s + { cwd: ($p.cwd // $s.cwd), model: ($p.model // $s.model), out: null }
     elif $j.type == "event_msg" and $p.type == "token_count"
          and $p.info.last_token_usage and $s.model
          and ($p.info.total_token_usage.total_tokens // null) != $s.total then
       $p.info.last_token_usage as $u
       | $s + { total: ($p.info.total_token_usage.total_tokens // null),
                out: { dir: ($s.cwd // ""), d: ($j.timestamp // "" | .[0:10]),
                       m: $s.model, fast: false,
                       i: (($u.input_tokens // 0) - ($u.cached_input_tokens // 0)),
                       r: ($u.cached_input_tokens // 0), o: ($u.output_tokens // 0),
                       w5: 0, w1: 0 } }
     else $s + { out: null } end;
   .out // empty)] ${GROUP}`,
  },
  opencode: {
    source: `[ -f "$1/opencode.db" ] || exit 0; "$2" -readonly "$1/opencode.db" "SELECT json_object('id', id, 'data', json(data)) FROM message WHERE json_extract(data, '$.role') = 'assistant'"`,
    jq: `
[inputs | fromjson? | .data as $m | select($m.modelID and $m.tokens)
 | $m.tokens as $u
 | { id, dir: ($m.path.cwd // ""), m: $m.modelID, fast: false,
     d: ($m.time.created // 0 | ./1000 | strftime("%Y-%m-%d")),
     i: ($u.input // 0), o: (($u.output // 0) + ($u.reasoning // 0)),
     r: ($u.cache.read // 0), w5: ($u.cache.write // 0), w1: 0 }]
| unique_by(.id) ${GROUP}`,
  },
};

const expandHome = (p) => p.replace(/^~(?=\/|$)/, home());

// One agent's groups: [{ dir, day, model, fast, input, output, read, write5m,
// write1h }]. An agent that was never used (no folder) gives none.
async function scan(agent) {
  const reader = READERS[agent.type];
  if (!reader) throw new Error(`usage: unknown agent type ${agent.type}`);
  const r = await exec("/bin/sh", [
    "-c",
    `(set -o pipefail) 2>/dev/null && set -o pipefail; { ${reader.source}; } | "$3" -R -n -c "$4"`,
    "sh",
    expandHome(agent.home),
    C.programs.sqlite3,
    C.programs.jq,
    reader.jq,
  ]);
  if (r.code !== 0)
    throw new Error(`usage: ${(r.stderr ?? "").trim().split("\n")[0]}`);
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ agent: agent.type, ...JSON.parse(line) }));
}

// Model -> $ per token { i, o, w, w1, r, fast } from LiteLLM's list.
const PRICE_JQ = `
with_entries(select(.value | type == "object" and .input_cost_per_token != null)
  | .value |= { i: .input_cost_per_token, o: (.output_cost_per_token // 0),
                w: .cache_creation_input_token_cost,
                w1: .cache_creation_input_token_cost_above_1hr,
                r: .cache_read_input_token_cost,
                fast: .provider_specific_entry.fast })`;

let priceCache = null; // { at, table }

async function prices() {
  if (priceCache && Date.now() - priceCache.at < PRICES_MS)
    return priceCache.table;
  const file = `${appHome()}/usage-prices.json`;
  // Downloads only when the list changed (-z), and never replaces the last
  // good copy with a failed one. curl gets less than exec's 30 s so a slow
  // download still leaves time to read the last copy.
  const r = await exec("/bin/sh", [
    "-c",
    '"$3" -sfL --max-time 20 -z "$1" -o "$1.tmp" "$2" && [ -s "$1.tmp" ] && mv "$1.tmp" "$1"; rm -f "$1.tmp"; [ -f "$1" ] && "$4" -c "$5" "$1"',
    "sh",
    file,
    C.usage.prices,
    C.programs.curl,
    C.programs.jq,
    PRICE_JQ,
  ]).catch(() => null);
  // A failed load isn't cached, so the next refresh tries again.
  try {
    if (r?.code === 0) {
      priceCache = { at: Date.now(), table: JSON.parse(r.stdout) };
      return priceCache.table;
    }
  } catch {}
  return priceCache?.table ?? {};
}

// A model's price: its own, else without a [1m]-style tag or date suffix.
export function priceOf(table, model) {
  const bare = model.replace(/\[.*\]$/, "");
  return table[model] ?? table[bare] ?? table[bare.replace(/-\d{8}$/, "")] ?? null;
}

// One group's cost in $, or null for a model without a price. A cache write
// without its own price costs what input does; a 1 h one what a 5 min one does.
export function costOf(table, u) {
  const p = priceOf(table, u.model);
  if (!p) return null;
  const w = p.w ?? p.i;
  const dollars =
    u.input * p.i +
    u.write5m * w +
    u.write1h * (p.w1 ?? w) +
    u.read * (p.r ?? p.i) +
    u.output * p.o;
  return u.fast ? dollars * (p.fast ?? 1) : dollars;
}

// Every configured agent's groups, priced: [{ agent, dir, day, model, fast,
// input, output, read, write5m, write1h, cost }]. A failed scan throws.
export async function usageGroups() {
  const [table, ...scans] = await Promise.all([
    prices(),
    ...C.usage.agents.map(scan),
  ]);
  return scans.flat().map((g) => ({ ...g, cost: costOf(table, g) }));
}

// Sums groups: { cost, tokens, unpriced } (unpriced: tokens of models
// without a price, left out of cost).
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

// What was spent working in `dir`, or null with nothing there.
export function costIn(groups, dir) {
  const mine = groups.filter((g) => g.dir === dir);
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
