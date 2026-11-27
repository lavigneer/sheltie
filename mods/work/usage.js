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
import { errorMessage } from "./errors.js";

const PRICES_MS = 3_600_000;

// Shared with the other sidebar: a scan younger than this is reused (each
// sidebar refreshes every 2 minutes, so together they scan once per interval).
export const SHARE_MS = 100_000;

// Shell scripts printing an agent's records, given $1 = its home, $2 =
// sqlite3, $3 = jq, $4 = the reader's jq, $5 = its cache folder and $6 = 1 to
// print every log (else only the ones made again). A missing folder or
// database (agent never used) prints none. Output, one line per log: its cache
// file as "C<TAB>file" if it was made again, else "U<TAB>file". The caller
// reads the records of a changed file, lines of { id?, dir, d, m, fast, i, o,
// r, w5, w1 }.
//
// JSONL: each log's records are kept in $5/<log's path>, made again only when
// the log is newer (-nt compares whole seconds, so a write in the same second
// as the last read can go unseen until the next). The cache takes the log's
// mtime from before it was read, so a line written meanwhile makes it stale.
// A half-written last line is skipped until the log grows. Stale logs are read
// four at a time.
/** @param {string} dir */
const JSONL = (dir) => `[ -d "$1/${dir}" ] || exit 0
mkdir -p "$5" && changed="$5.changed.$$" && : > "$changed" || exit 1
find "$1/${dir}" -name "*.jsonl" -type f | while IFS= read -r f; do
  c="$5$f"
  if [ ! -f "$c" ] || [ "$f" -nt "$c" ]; then printf '%s\\0' "$f"; fi
done | xargs -0 -n 1 -P 4 sh -c '
  [ -n "$5" ] || exit 0
  c="$3$5"
  mkdir -p "\${c%/*}" && : > "$c.s$$" && touch -r "$5" "$c.s$$" \\
    && "$1" -R -n -c "$2" "$5" > "$c.t$$" && touch -r "$c.s$$" "$c.t$$" \\
    && mv "$c.t$$" "$c" || { rm -f "$c.s$$" "$c.t$$"; exit 1; }
  rm -f "$c.s$$"
  printf "%s\\\\n" "$5" >> "$4"' sh "$3" "$4" "$5" "$changed" \\
  || { rm -f "$changed"; exit 1; }
ch="
$(cat "$changed")
"
find "$1/${dir}" -name "*.jsonl" -type f | while IFS= read -r f; do
  c="$5$f"
  case $ch in *"
$f
"*) ;; *) [ "$6" = 1 ] || { printf 'U\\t%s\\n' "$c"; continue; } ;; esac
  printf 'C\\t%s\\n' "$c"
done
rm -f "$changed"`;

// Logs are still being written and may hold anything: a line that can't be
// read is skipped, a token count that isn't a positive number counts as 0
// and a text field of another type as "".
const NUM = `
def tok: if type == "number" and . > 0 then . else 0 end;
def str: if type == "string" then . else "" end;`;

// Each reader's jq turns its source's lines (one log's, for JSONL) into records.
/** @type {Record<string, { source: string, jq: string }>} */
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
     | if $j.type == "session_meta" then $s + { cwd: (($p.cwd | strings) // $s.cwd), out: null }
       elif $j.type == "turn_context" then
         $s + { cwd: (($p.cwd | strings) // $s.cwd),
                model: (($p.model | strings) // $s.model), out: null }
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
    // Its database is one section, read whole each scan into its cache file.
    source: `[ -f "$1/opencode.db" ] || exit 0; command -v "$2" >/dev/null || { echo "opencode needs sqlite3 (settings: programs.sqlite3)" >&2; exit 127; }; mkdir -p "$5" && "$2" -readonly "$1/opencode.db" "SELECT json_object('id', id, 'data', json(data)) FROM message WHERE json_extract(data, '$.role') = 'assistant'" | "$3" -R -n -c "$4" > "$5/opencode.jsonl" && printf 'C\\t%s\\n' "$5/opencode.jsonl"`,
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

/** @param {string} p */
const expandHome = (p) => p.replace(/^~(?=\/|$)/, home());

// What one agent's scans have counted, kept in memory between scans (per
// agent and home): each log's records as read, the message ids already
// counted (a message repeated in a later log is counted once: the first is
// kept, across files too, since a resumed session repeats its history in a new
// log) and the sums per { dir, day, model, fast }. A scan applies only the
// logs that changed, so its cost doesn't grow with the history it has read.
/**
 * @typedef {{ at: number, logs: Map<string, any[]>, seen: Set<string>,
 *   groups: Map<string, any> }} Counted
 */
/** @type {Map<string, Counted>} */
const counted = new Map();

// Scans of all agents run one at a time: they share the state above.
/** @type {Promise<any>} */
let queue = Promise.resolve();

// One agent's groups: [{ agent, dir, day, model, fast, input, output, read,
// write5m, write1h }]. An agent that was never used (no folder) gives none. A
// scan younger than maxAge ms is reused.
/** @param {{ type: string, home: string }} agent @param {number} maxAge */
function scan(agent, maxAge) {
  const job = queue.then(() => scanNow(agent, maxAge));
  queue = job.catch(() => {});
  return job;
}

/** @param {{ type: string, home: string }} agent @param {number} maxAge */
async function scanNow(agent, maxAge) {
  const reader = READERS[agent.type];
  if (!reader) throw new Error(`usage: unknown agent type ${agent.type}`);
  const key = `${agent.type}\0${agent.home}`;
  const known = counted.get(key);
  if (known && Date.now() - known.at < maxAge) return groupsOf(known, agent);
  const at = Date.now();
  try {
    // A scan that can't be matched to what was counted starts over.
    const next =
      applySections(known, await read(agent, reader, !known)) ??
      applySections(undefined, await read(agent, reader, true));
    if (!next) throw new Error("usage: the logs changed while scanning");
    next.at = at;
    counted.set(key, next);
    return groupsOf(next, agent);
  } catch (e) {
    counted.delete(key);
    throw e;
  }
}

/** @param {{ type: string, home: string }} agent @param {{ source: string, jq: string }} reader @param {boolean} full */
async function read(agent, reader, full) {
  const r = await exec("/bin/sh", [
    "-c",
    `(set -o pipefail) 2>/dev/null && set -o pipefail
${reader.source}`,
    "sh",
    expandHome(agent.home).replace(/(.)\/+$/, "$1"),
    C.programs.sqlite3,
    C.programs.jq,
    reader.jq,
    `${appHome()}/usage-cache/${agent.type}`,
    full ? "1" : "0",
  ]);
  if (r.code !== 0)
    throw new Error(`usage: ${(r.stderr ?? "").trim().split("\n")[0]}`);
  // The sections the script listed: [{ path, changed, recs }]. A changed
  // log's records are read from its cache file on their own, so no single
  // output grows with the whole history.
  const list = r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      path: line.slice(2),
      changed: line[0] === "C",
      /** @type {any[]} */
      recs: [],
    }));
  await Promise.all(
    list
      .filter((s) => s.changed)
      .map(async (s) => {
        const c = await exec("/bin/cat", [s.path]);
        if (c.code !== 0)
          throw new Error(`usage: ${(c.stderr ?? "").trim().split("\n")[0]}`);
        s.recs = c.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      }),
  );
  return list;
}

// Brings `known` (undefined: nothing counted yet) up to the logs in `list`, in
// listing order. Null when `known` no longer matches them: a log that lost or
// changed a record, or one that's gone, means counting starts over.
/** @param {Counted | undefined} known @param {{ path: string, changed: boolean, recs: any[] }[]} list */
function applySections(known, list) {
  const logs = new Map();
  let rebuild = !known;
  /** @type {any[][]} */
  const extra = [];
  for (const s of list) {
    const old = known?.logs.get(s.path);
    if (!s.changed) {
      if (!old) return null;
      logs.set(s.path, old);
      continue;
    }
    logs.set(s.path, s.recs);
    const grown = old ? grownBy(old, s.recs) : s.recs;
    if (grown) extra.push(grown);
    else rebuild = true;
  }
  if (known)
    for (const p of known.logs.keys()) if (!logs.has(p)) rebuild = true;
  /** @type {Counted} */
  const next =
    known && !rebuild
      ? { ...known, logs }
      : { at: 0, logs, seen: new Set(), groups: new Map() };
  if (rebuild)
    for (const recs of logs.values()) for (const r of recs) count(next, r);
  else for (const recs of extra) for (const r of recs) count(next, r);
  return next;
}

// The records of `recs` that `old` doesn't have, or null when `old` has one
// that's gone or changed (a log only grows). Codex records have no id: their
// place in the log stands in for it.
/** @param {any[]} old @param {any[]} recs */
function grownBy(old, recs) {
  const key = (/** @type {any} */ r, /** @type {number} */ i) =>
    r.id ?? `#${i}`;
  const now = new Map(recs.map((r, i) => [key(r, i), JSON.stringify(r)]));
  /** @type {Set<string>} */
  const had = new Set();
  for (const [i, r] of old.entries()) {
    const k = key(r, i);
    if (now.get(k) !== JSON.stringify(r)) return null;
    had.add(k);
  }
  return recs.filter((r, i) => !had.has(key(r, i)));
}

/** @param {Counted} st @param {any} r */
function count(st, r) {
  if (r.id != null) {
    if (st.seen.has(r.id)) return;
    st.seen.add(r.id);
  }
  const k = JSON.stringify([r.dir, r.d, r.m, r.fast]);
  const g = st.groups.get(k) ?? {
    dir: r.dir,
    day: r.d,
    model: r.m,
    fast: r.fast,
    input: 0,
    output: 0,
    read: 0,
    write5m: 0,
    write1h: 0,
  };
  g.input += r.i;
  g.output += r.o;
  g.read += r.r;
  g.write5m += r.w5;
  g.write1h += r.w1;
  st.groups.set(k, g);
}

/** @param {Counted} st @param {{ type: string }} agent */
function groupsOf(st, agent) {
  return [...st.groups.values()].map((g) => ({ agent: agent.type, ...g }));
}

// Model -> $ per token { i, o, w, w1, r, fast } from LiteLLM's list.
const PRICE_JQ = `
with_entries(select(.value | type == "object" and .input_cost_per_token != null)
  | .value |= { i: .input_cost_per_token, o: (.output_cost_per_token // 0),
                w: .cache_creation_input_token_cost,
                w1: .cache_creation_input_token_cost_above_1hr,
                r: .cache_read_input_token_cost,
                fast: .provider_specific_entry.fast })`;

/** @type {{ at: number, table: Record<string, any> } | null} */
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
/** @param {Record<string, any>} table @param {string} model */
export function priceOf(table, model) {
  const bare = model.replace(/\[.*\]$/, "");
  return (
    table[model] ?? table[bare] ?? table[bare.replace(/-\d{8}$/, "")] ?? null
  );
}

// One group's cost in $, or null for a model without a price. A cache write
// without its own price costs what input does; a 1 h one what a 5 min one does.
/** @param {Record<string, any>} table @param {any} u */
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

// The state after `read` (which resolves to the payload stored under `key`)
// finishes. The plan limits use the same shape with key "list".
/** @param {any} state @param {() => Promise<any>} read @param {string} [key] */
export async function settled(state, read, key = "groups") {
  try {
    return { phase: "ready", [key]: await read(), error: null };
  } catch (e) {
    return {
      phase: "failed",
      [key]: state[key],
      error: errorMessage(e),
    };
  }
}

// Sums groups: { cost, tokens, unpriced } (unpriced: tokens of models
// without a price, left out of cost).
/** @param {any[]} groups */
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
/** @param {any[]} groups @param {string} dir */
export function costIn(groups, dir) {
  const mine = groups.filter((g) => g.dir === dir);
  return mine.length ? total(mine).cost : null;
}

/** @param {number} n */
export const dollars = (n) =>
  n >= 100
    ? `$${Math.round(n)}`
    : n >= 0.01 || n === 0
      ? `$${n.toFixed(2)}`
      : "<$0.01";

/** @param {number} n */
export const tokenCount = (n) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${Math.round(n / 1e3)}k`
        : String(n);
