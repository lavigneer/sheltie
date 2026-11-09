// Starting work on a ticket: its branch and worktree, the tracker's "start"
// step, and a space with the agent and the ticket as its first message. Shared
// by the tickets popup (Enter) and the Work sidebar's work.start command (for
// agents and scripts).

import {
  exec,
  notify,
  readTextFile,
  run,
  setShared,
  shared,
  writeTextFile,
} from "herdr";
import { C } from "./config.js";
import { addWorktree, branchFor, cloneRepo, localRepos } from "./git.js";
import { fill, firstLine, spaceFor } from "./lib.js";
import { tracker } from "./tracker.js";
import {
  findRepo,
  listTickets,
  openWork,
  suggestRepos,
  workFor,
} from "./work.js";

/** @typedef {import("./types.js").Ticket} Ticket */
/** @typedef {import("./types.js").Repo} Repo */
/** @typedef {import("./types.js").WorkItem} WorkItem */

const REMEMBER = "tickets.repo"; // shared: ticket key -> repo slug or path

export const repoId = (repo) => repo.slug || repo.path;
export const errorText = (e) =>
  firstLine(`${e?.message ?? e}`) || "Something went wrong";

// The repo last used for a ticket (a slug or path), for suggestRepos.
export const rememberedRepo = (key) => shared(REMEMBER)?.[key];

export function remember(ticket, repo) {
  setShared(REMEMBER, {
    ...(shared(REMEMBER) ?? {}),
    [ticket.key]: repoId(repo),
  });
}

// What the agent's first messages can say about a ticket.
export function taskValues(ticket, extra = {}) {
  return {
    key: ticket.key,
    label: ticket.label,
    summary: ticket.summary,
    branch: branchFor(ticket, extra.repo),
    worktreeDir: C.worktreeDir,
    viewCommand: (ticket.tracker ?? tracker()).viewCommand(ticket.key),
    ...extra,
  };
}

// The space's name: the ticket, plus the repo when it has work in others too.
export function spaceName(ticket, repo, work = []) {
  const others = work.filter((w) => repoId(w.repo) !== repoId(repo));
  return others.length ? `${ticket.label} ${repo.name}` : ticket.label;
}

// Everything up to opening the space for new work on the ticket's own branch
// in `target` (cloned first if it isn't local): { name, folder, task, repo }.
// `work` is the ticket's known work, so an existing worktree is reused (and
// its agent not told the task again). `onStep` hears what's happening.
/** @param {Ticket} ticket @param {Repo} target @param {WorkItem[]} work @param {(message: string) => void} [onStep] */
export async function prepareStart(ticket, target, work, onStep = () => {}) {
  let repo = target;
  if (!repo.path) {
    onStep(`Cloning ${repo.slug}…`);
    repo = await cloneRepo(repo.slug);
  }
  const branch = branchFor(ticket, repo);
  const existing = work.find(
    (w) => w.repo.path === repo.path && w.branch === branch && w.worktree,
  );
  const path =
    existing?.worktree ?? (await addWorktree(repo, branch, { create: true }));
  remember(ticket, repo);
  // Work has started: the tracker's "start" step (a Jira transition, if
  // configured). A failure is reported and stops nothing.
  onStep(`Starting ${ticket.label}…`);
  await (ticket.tracker ?? tracker())
    .move(ticket.key, "start", ticket.status)
    .catch((e) =>
      notify({
        title: `${ticket.label}: couldn't update the ticket`,
        body: errorText(e),
        level: "warning",
      }),
    );
  return {
    repo,
    name: spaceName(ticket, repo, work),
    folder: path,
    task: existing ? null : fill(C.agent.task, taskValues(ticket, { repo })),
  };
}

// Each one's space: selected if one's already open there, else a new one
// with the agent (and its task, if any).
/** @param {{ name: string, folder: string, task?: string | null }[]} list */
export function openSpaces(list) {
  for (const { name, folder, task } of list) {
    const open = spaceFor(folder);
    if (open) run("space.select", { id: open.id });
    else
      run("space.new", {
        name,
        folder,
        argv: C.agent.argv,
        ...(task ? { task } : {}),
      });
  }
}

// A request's entries: a ticket's key or label ("WEB-142", "owner/repo#12",
// "#12"), or { ticket, repo } to pick the repo ("owner/repo" or a path).
/** @param {unknown} request @returns {{ ticket: string, repo: string | null }[]} */
export function requested(request) {
  const list = /** @type {any} */ (request)?.tickets;
  if (!Array.isArray(list))
    throw new Error('expected { "tickets": ["WEB-142", ...] }');
  return list.map((e) => {
    const ticket = typeof e === "string" ? e : e?.ticket;
    if (typeof ticket !== "string" || !ticket.trim())
      throw new Error(`not a ticket: ${JSON.stringify(e)}`);
    const repo = typeof e === "string" ? null : (e.repo ?? null);
    return { ticket: ticket.trim(), repo };
  });
}

// The ticket an entry names: one of `tickets` by key, or by label when only
// one has it (labels like "#12" can repeat); case doesn't matter. Else null.
/** @param {string} name @param {Ticket[]} tickets */
export function ticketNamed(name, tickets) {
  const n = name.toLowerCase();
  const byKey = tickets.find((t) => t.key.toLowerCase() === n);
  if (byKey) return byKey;
  const byLabel = tickets.filter((t) => t.label.toLowerCase() === n);
  return byLabel.length === 1 ? byLabel[0] : null;
}

// Starts each requested ticket (see requested()) like Enter in the tickets
// popup: in the entry's repo, else its best suggested one. Tickets that
// already have work (a branch, worktree or PR) are skipped: the person
// decides what to do with those. All the spaces open at the end. Returns
// one result per entry: { ticket, status: "started" | "skipped" | "failed",
// folder?, repo?, why? }.
/** @param {unknown} request */
export async function startRequested(request) {
  const entries = requested(request);
  const repos = await localRepos();
  const listed = await listTickets(repos);
  const results = [];
  const found = [];
  for (const e of entries) {
    let t = ticketNamed(e.ticket, listed);
    if (!t) {
      const global = tracker();
      const viewed = await global.view(e.ticket).catch(() => null);
      t = viewed && { ...viewed, tracker: global, homes: [] };
    }
    if (t) found.push({ e, t });
    else
      results.push({
        ticket: e.ticket,
        status: "failed",
        why: "no such ticket",
      });
  }
  const work = await workFor(
    found.map((f) => f.t),
    repos,
  );
  const spaces = [];
  for (const { e, t } of found) {
    const result = { ticket: t.key, label: t.label };
    results.push(result);
    if (openWork(work.get(t.key) ?? []).length) {
      Object.assign(result, {
        status: "skipped",
        why: "already has open work",
      });
      continue;
    }
    const target = e.repo
      ? findRepo(e.repo, repos)
      : suggestRepos(t, repos, null, rememberedRepo(t.key))[0]?.repo;
    if (!target) {
      Object.assign(result, { status: "failed", why: "no repo for it" });
      continue;
    }
    try {
      const s = await prepareStart(t, target, []);
      spaces.push(s);
      Object.assign(result, {
        status: "started",
        repo: repoId(s.repo),
        folder: s.folder,
      });
    } catch (err) {
      Object.assign(result, { status: "failed", why: errorText(err) });
    }
  }
  openSpaces(spaces);
  return results;
}

const DAY_MIN = "1440"; // results nobody collected are removed after a day

// work.start's queue, <dir> (<app home>/work-start): each request is its own
// <id>.json, so callers never overwrite each other (write it as <id>.json.tmp
// and rename it, so it's never read half-written). Handles every request
// waiting, oldest first, one at a time (run it through serial(), so two
// work.starts never race on a ticket): removes it, starts its tickets and
// writes <id>.result.json, { at, results } or { at, error }, for the caller
// to read and remove.
/** @param {string} dir @param {(request: unknown) => Promise<unknown[]>} [start] */
export async function drainRequests(dir, start = startRequested) {
  await exec("find", [
    dir,
    "-name",
    "*.result.json",
    "-mmin",
    `+${DAY_MIN}`,
    "-delete",
  ]);
  const ls = await exec("ls", ["-1tr", dir]);
  const ids = ls.stdout
    .split("\n")
    .filter((f) => f.endsWith(".json") && !f.endsWith(".result.json"))
    .map((f) => f.slice(0, -".json".length));
  for (const id of ids) {
    const file = `${dir}/${id}.json`;
    const text = await readTextFile(file);
    await exec("rm", ["-f", file]);
    /** @type {{ at: number, results?: unknown[], error?: string }} */
    const out = { at: Date.now() };
    try {
      if (text == null) throw new Error(`couldn't read ${file}`);
      out.results = await start(JSON.parse(text));
    } catch (e) {
      out.error = `${e?.message ?? e}`;
      notify({ title: "work.start failed", body: out.error, level: "error" });
    }
    await writeTextFile(
      `${dir}/${id}.result.json`,
      `${JSON.stringify(out, null, 2)}\n`,
      null,
    );
  }
}
