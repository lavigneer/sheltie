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
import {
  findRepo,
  listTickets,
  openWork,
  suggestRepos,
  viewTicket,
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
    viewCommand: ticket.tracker.viewCommand(ticket.key),
    ...extra,
  };
}

// The space's name: the ticket, plus the repo when it has work in others too.
export function spaceName(ticket, repo, work = []) {
  const others = work.filter((w) => repoId(w.repo) !== repoId(repo));
  return others.length ? `${ticket.label} ${repo.name}` : ticket.label;
}

// A repo cloned in place of `target` in `repos` (or added), so later choices
// find it local.
export function learnClone(repos, target, cloned) {
  const at = repos.indexOf(target);
  if (at >= 0) repos[at] = cloned;
  else repos.push(cloned);
}

// Everything up to opening the space for new work on the ticket's own branch
// in `target` (cloned first if it isn't local, and `repos` told): { name,
// folder, task, repo }. `work` is the ticket's known work, so an existing
// worktree is reused (and its agent not told the task again). `onStep` hears
// what's happening.
/** @param {Ticket} ticket @param {Repo} target @param {{ work?: WorkItem[], repos?: Repo[], onStep?: (message: string) => void }} [opts] */
export async function prepareStart(
  ticket,
  target,
  { work = [], repos = [], onStep = () => {} } = {},
) {
  let repo = target;
  if (!repo.path) {
    onStep(`Cloning ${repo.slug}…`);
    repo = await cloneRepo(repo.slug);
    learnClone(repos, target, repo);
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
  await ticket.tracker.move(ticket.key, "start", ticket.status).catch((e) =>
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

/**
 * @typedef {{ ticket: string, label?: string, status: "started" | "skipped" | "failed", why?: string, repo?: string, folder?: string }} StartResult
 */

// Starts each of `entries` ({ ticket, repo }): in its repo, else the ticket's
// best suggested one (`here` is the current repo, a hint). Tickets with open
// work in `work` (key -> WorkItem[]: a branch, worktree or open PR) are
// skipped, the person decides what to do with those; otherwise an existing
// worktree for its branch is reused, untold. `repos` learns any clone. The
// spaces aren't opened: that's the caller's, once all are ready. Returns one
// result per entry (StartResult) and the spaces to open.
/**
 * @param {{ ticket: Ticket, repo: Repo | null }[]} entries
 * @param {{ repos: Repo[], work: Map<string, WorkItem[]>, here?: string | null, onStep?: (message: string) => void }} opts
 */
export async function startTickets(
  entries,
  { repos, work, here = null, onStep = () => {} },
) {
  /** @type {StartResult[]} */
  const results = [];
  const spaces = [];
  for (const { ticket: t, repo } of entries) {
    const result = { ticket: t.key, label: t.label };
    results.push(/** @type {StartResult} */ (result));
    const known = work.get(t.key) ?? [];
    if (openWork(known).length) {
      Object.assign(result, {
        status: "skipped",
        why: "already has open work",
      });
      continue;
    }
    const target =
      repo ?? suggestRepos(t, repos, here, rememberedRepo(t.key))[0]?.repo;
    if (!target) {
      Object.assign(result, { status: "failed", why: "no repo for it" });
      continue;
    }
    try {
      const s = await prepareStart(t, target, { work: known, repos, onStep });
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
  return { results, spaces };
}

// work.start: each requested ticket (see requested()) found by key or label,
// started by startTickets, and all the spaces opened at the end. Returns one
// StartResult per entry.
/** @param {unknown} request */
export async function startRequested(request) {
  const entries = requested(request);
  const repos = await localRepos();
  const listed = await listTickets(repos);
  /** @type {StartResult[]} */
  const missing = [];
  const found = [];
  for (const e of entries) {
    const t =
      ticketNamed(e.ticket, listed) ??
      (await viewTicket(e.ticket, e.repo ? findRepo(e.repo, repos) : null));
    if (t) found.push({ ticket: t, repo: findRepo(e.repo, repos) });
    else
      missing.push({
        ticket: e.ticket,
        status: "failed",
        why: "no such ticket",
      });
  }
  const work = await workFor(
    found.map((f) => f.ticket),
    repos,
  );
  const { results, spaces } = await startTickets(found, { repos, work });
  openSpaces(spaces);
  return [...missing, ...results];
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
