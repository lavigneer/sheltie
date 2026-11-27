// A fake `gh` whose faults a test sets between calls: the GraphQL answers for
// prDetailsMany (prs.js), with its failure modes. Every call is logged, so a
// test can count how many reached it. Used by the chaos and performance tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Each call is logged to calls.log. Faults (faults.json) are read per call:
//   down: every call fails like GitHub's 502
//   rateLimited: every call says it's rate limited
//   garbage: every call answers 200 with a non-JSON body
//   fail: pull request numbers whose lookup answers a GraphQL error
//   prs: the pullRequest nodes that exist (see prNode in fake-tools.mjs)
const SCRIPT = `#!${process.execPath}
const fs = require("node:fs");
const dir = ${"__DIR__"};
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.log", JSON.stringify(args) + "\\n");
const f = JSON.parse(fs.readFileSync(dir + "/faults.json", "utf8"));
if (f.rateLimited) { process.stderr.write("API rate limit exceeded\\n"); process.exit(1); }
if (f.down) { process.stderr.write("HTTP 502\\n"); process.exit(1); }
if (f.garbage) { process.stdout.write("<html>upstream sent garbage</html>"); process.exit(0); }
const vars = {};
let query = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-F" || args[i] === "-f") {
    const at = args[i + 1].indexOf("=");
    const k = args[i + 1].slice(0, at), v = args[i + 1].slice(at + 1);
    if (k === "query") query = v; else vars[k] = v;
    i++;
  }
}
const prs = f.prs ?? [];
// updatedAt: a hash of the node, so it changes whenever the PR does.
const stamp = (p) => p && { ...p, updatedAt: require("node:crypto").createHash("sha1").update(JSON.stringify(p)).digest("hex") };
const byNumber = (n) => stamp(prs.find((p) => String(p.number) === String(n)) ?? null);
const repository = {};
const errors = [];
for (const [, alias, number] of query.matchAll(/(p\\d+): pullRequest\\(number: (\\d+)\\)/g)) {
  if ((f.fail ?? []).includes(Number(number))) {
    errors.push({ message: "Something went wrong", path: ["repository", alias] });
    repository[alias] = null;
  } else repository[alias] = byNumber(number);
}
for (const [, alias, variable] of query.matchAll(/(b\\d+): pullRequests\\(headRefName: \\$(b\\d+)/g)) {
  const branch = vars[variable];
  const hit = prs.find((p) => p.headRefName === branch);
  if (hit && (f.fail ?? []).includes(hit.number)) {
    errors.push({ message: "Something went wrong", path: ["repository", alias] });
    repository[alias] = null;
  } else repository[alias] = { nodes: hit ? [stamp(hit)] : [] };
}
process.stdout.write(JSON.stringify({ data: { repository }, ...(errors.length ? { errors } : {}) }));
`;

/** @returns {{ gh: string, faults: (f: object) => void, calls: () => string[][], graphqlCalls: () => number }} */
export function faultyGh() {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "sheltie-gh-fault-")),
  );
  const gh = path.join(dir, "gh");
  fs.writeFileSync(gh, SCRIPT.replace("__DIR__", JSON.stringify(dir)));
  fs.chmodSync(gh, 0o755);
  const faultsFile = path.join(dir, "faults.json");
  const faults = (f) => fs.writeFileSync(faultsFile, JSON.stringify(f));
  faults({});
  const calls = () => {
    const log = path.join(dir, "calls.log");
    return fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  };
  const graphqlCalls = () =>
    calls().filter((a) => a.includes("graphql")).length;
  return { gh, faults, calls, graphqlCalls };
}
