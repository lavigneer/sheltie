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

// Shared with the other sidebar: a scan younger than this is reused (each
// sidebar refreshes every 2 minutes, so together they scan once per interval).
export const SHARE_MS = 100_000;

// Per (agent, cwd, UTC day, model, fast) token sums from record lines
// { id?, dir, d, m, fast, i, o, r, w5, w1 }, grouped as they stream. Records
// sharing an id are one message (the first is kept), across files too: a
// resumed session repeats its history in a new log.
const GROUP = `
reduce inputs as $r ({ seen: {}, g: {} };
  if $r.id and .seen[$r.id] then . else
    (if $r.id then .seen[$r.id] = true else . end)
    | ([$r.d, $r.m, $r.fast, $r.dir] | tojson) as $k
    | .g[$k] |= { dir: $r.dir, day: $r.d, model: $r.m, fast: $r.fast,
        input: ((.input // 0) + $r.i), output: ((.output // 0) + $r.o),
        read: ((.read // 0) + $r.r), write5m: ((.write5m // 0) + $r.w5),
        write1h: ((.write1h // 0) + $r.w1) } end)
| [.g[]] | sort_by(.day, .model, .fast, .dir)[]`;

// Shell scripts printing an agent's records, given $1 = its home, $2 =
// sqlite3, $3 = jq, $4 = the reader's jq and $5 = its cache folder. A missing
// folder or database (agent never used) prints none.
// JSONL: each log's records are kept in $5/<log's path>, made again only when
// the log is newer. The cache takes the log's mtime from before it was read,
// so a line written meanwhile makes it stale. A half-written last line is
// skipped until the log grows.
const JSONL = (dir) => `[ -d "$1/${dir}" ] || exit 0
find "$1/${dir}" -name "*.jsonl" -type f | while IFS= read -r f; do
  c="$5$f"
  if [ ! -f "$c" ] || [ "$f" -nt "$c" ]; then
    mkdir -p "\${c%/*}" && : > "$c.s$$" && touch -r "$f" "$c.s$$" \\
      && "$3" -R -n -c "$4" "$f" > "$c.t$$" && touch -r "$c.s$$" "$c.t$$" \\
      && mv "$c.t$$" "$c" || { rm -f "$c.s$$" "$c.t$$"; exit 1; }
    rm -f "$c.s$$"
  fi
  cat "$c"
done`;

// Logs are still being written and may hold anything: a line that can't be
// read is skipped, a token count that isn't a positive number counts as 0
// and a text field of another type as "".
const NUM = `
def tok: if type == "number" and . > 0 then . else 0 end;
def str: if type == "string" then . else "" end;`;

// Each reader's jq turns its source's lines (one log's, for JSONL) into records.
const READERS = {
  "claude-code": {
    source: JSONL("projects"),
    jq: `${NUM}
[inputs | fromjson? | try (
   select(.type == "assistant" and (.message.id | type) == "string"
     and .message.usage and (.message.model | type) == "string"
     and .message.model != "<synthetic>")
   | .message as $m | $m.usage as $u
   | { id: $m.id, dir: (.cwd | str), d: (.timestamp | str | .[0:10]),
       m: $m.model, fast: ($u.speed == "fast"),
       i: ($u.input_tokens | tok), o: ($u.output_tokens | tok),
       r: ($u.cache_read_input_tokens | tok),
       w5: (if $u.cache_creation then $u.cache_creation.ephemeral_5m_input_tokens | tok
            else $u.cache_creation_input_tokens | tok end),
       w1: ($u.cache_creation.ephemeral_1h_input_tokens | tok) }
 ) catch empty]
| unique_by(.id)[]`,
  },
  codex: {
    source: JSONL("sessions"),
    jq: `${NUM}
foreach (inputs | fromjson? // null | select(.)) as $j
  ({};
   . as $s
   | try (
     $j.payload as $p
     | if $j.type == "session_meta" then $s + { cwd: ($p.cwd | strings) // $s.cwd, out: null }
       elif $j.type == "turn_context" then
         $s + { cwd: ($p.cwd | strings) // $s.cwd,
                model: ($p.model | strings) // $s.model, out: null }
       elif $j.type == "event_msg" and $p.type == "token_count"
            and $p.info.last_token_usage and $s.model
            and ($p.info.total_token_usage.total_tokens // null) != $s.total then
         $p.info.last_token_usage as $u
         | ($u.cached_input_tokens | tok) as $cached
         | $s + { total: ($p.info.total_token_usage.total_tokens // null),
                  out: { dir: ($s.cwd // ""), d: ($j.timestamp | str | .[0:10]),
                         m: $s.model, fast: false,
                         i: ([($u.input_tokens | tok) - $cached, 0] | max),
                         r: $cached, o: ($u.output_tokens | tok),
                         w5: 0, w1: 0 } }
       else $s + { out: null } end
   ) catch ($s + { out: null });
   .out // empty)`,
  },
  opencode: {
    source: `[ -f "$1/opencode.db" ] || exit 0; command -v "$2" >/dev/null || { echo "opencode needs sqlite3 (settings: programs.sqlite3)" >&2; exit 127; }; "$2" -readonly "$1/opencode.db" "SELECT json_object('id', id, 'data', json(data)) FROM message WHERE json_extract(data, '$.role') = 'assistant'" | "$3" -R -n -c "$4"`,
    jq: `${NUM}
inputs | fromjson? | try (
  .data as $m | select(($m.modelID | type) == "string" and $m.tokens)
  | $m.tokens as $u
  | { id: (.id | tostring), dir: ($m.path.cwd | str), m: $m.modelID, fast: false,
      d: ($m.time.created | tok | ./1000 | strftime("%Y-%m-%d")),
      i: ($u.input | tok), o: (($u.output | tok) + ($u.reasoning | tok)),
      r: ($u.cache.read | tok), w5: ($u.cache.write | tok), w1: 0 }
) catch empty`,
  },
};

const expandHome = (p) => p.replace(/^~(?=\/|$)/, home());

// One agent's groups: [{ dir, day, model, fast, input, output, read, write5m,
// write1h }]. An agent that was never used (no folder) gives none. The groups
// are kept in <cache>/<home>.groups after a "<scan time in ms>" line, and a
// scan younger than maxAge ms is reused from there.
async function scan(agent, maxAge) {
  const reader = READERS[agent.type];
  if (!reader) throw new Error(`usage: unknown agent type ${agent.type}`);
  const r = await exec("/bin/sh", [
    "-c",
    `(set -o pipefail) 2>/dev/null && set -o pipefail
out="$5$1.groups"
if [ -f "$out" ] && read -r at < "$out"; then
  case $at in ''|*[!0-9]*) ;; *) [ $(($6 - at)) -lt "$7" ] && { tail -n +2 "$out"; exit 0; } ;; esac
fi
mkdir -p "\${out%/*}" || exit 1
{ ${reader.source}
} | "$3" -n -c "$8" > "$out.t$$" || { rm -f "$out.t$$"; exit 1; }
{ echo "$6"; cat "$out.t$$"; } > "$out.u$$" && mv "$out.u$$" "$out"
cat "$out.t$$"; rm -f "$out.t$$" "$out.u$$"`,
    "sh",
    expandHome(agent.home).replace(/(.)\/+$/, "$1"),
    C.programs.sqlite3,
    C.programs.jq,
    reader.jq,
    `${appHome()}/usage-cache/${agent.type}`,
    String(Date.now()),
    String(maxAge),
    GROUP,
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
  return (
    table[model] ?? table[bare] ?? table[bare.replace(/-\d{8}$/, "")] ?? null
  );
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
// input, output, read, write5m, write1h, cost }]. A scan younger than maxAge
// ms (by either sidebar) is reused. A failed scan throws.
export async function usageGroups(maxAge = SHARE_MS) {
  const [table, ...scans] = await Promise.all([
    prices(),
    ...C.usage.agents.map((a) => scan(a, maxAge)),
  ]);
  return scans.flat().map((g) => ({ ...g, cost: costOf(table, g) }));
}

// The sidebar's load state: { phase: "loading" | "ready" | "failed", groups,
// error }. groups is null until a read succeeds; a failed read keeps the last.
export const LOADING = { phase: "loading", groups: null, error: null };

// The state after `read` (which resolves to groups) finishes.
export async function settled(state, read) {
  try {
    return { phase: "ready", groups: await read(), error: null };
  } catch (e) {
    return {
      phase: "failed",
      groups: state.groups,
      error: e?.message ?? String(e),
    };
  }
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
  n >= 100
    ? `$${Math.round(n)}`
    : n >= 0.01 || n === 0
      ? `$${n.toFixed(2)}`
      : "<$0.01";

export const tokenCount = (n) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${Math.round(n / 1e3)}k`
        : String(n);
