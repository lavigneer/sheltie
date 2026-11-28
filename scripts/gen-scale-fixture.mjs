#!/usr/bin/env node
// A large demo fixture (#369): the shape of demo/data-*.json, with as many
// repos, worktrees, PRs, issues and review requests as asked, for trying the
// mods (and timing the demo's fake gh and jira) at scale.
//
//   node scripts/gen-scale-fixture.mjs [--tracker github|jira] [--repos 50]
//     [--worktrees 20] [--issues 2000] [--reviews 50] [--out FILE]
//   demo/herdr-demo --reset --fixture FILE
//
// Without --out it writes to stdout. Generated files stay out of git (keep
// them outside the repo, or as demo/data-scale*.json, which .gitignore skips).
//
// Each repo (scale/svc-NN) gets an equal share of the issues; its first
// `worktrees` issues are worked on in a worktree each, and every other one of
// those has a PR (CI and reviews in a mix of states). The review requests are
// others' PRs, spread over the repos, requested a few minutes to days ago.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** @typedef {{ tracker?: "github" | "jira", repos?: number, worktrees?: number, issues?: number, reviews?: number }} Sizes */

const CHECKS = ["SUCCESS", "SUCCESS", "FAILURE", "IN_PROGRESS"];
const REVIEW = ["REVIEW_REQUIRED", "APPROVED", "CHANGES_REQUESTED"];
const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");

/** @param {Sizes} [sizes] */
export function scaleFixture({
  tracker = "github",
  repos = 50,
  worktrees = 20,
  issues = 2000,
  reviews = 50,
} = {}) {
  const perRepo = Math.max(1, Math.ceil(issues / repos));
  const jira = tracker === "jira";
  const names = Array.from({ length: repos }, (_, r) => `svc-${pad(r)}`);
  /** @type {any[]} */
  const issueList = [];
  /** @type {any[]} */
  const tickets = [];
  /** @type {any[]} */
  const prs = [];
  const repoList = names.map((name, r) => {
    const slug = `scale/${name}`;
    const branchesOf = [];
    for (
      let i = 1;
      i <= perRepo && issueList.length + tickets.length < issues;
      i++
    ) {
      // GitHub: issue #i of the repo, branch issue-i. Jira: SC-<n>, its
      // component the repo (repoRules below), branch me/SC-<n>.
      const n = r * perRepo + i;
      const title = `Scale task ${i} of ${name}`;
      if (jira)
        tickets.push({
          key: `SC-${n}`,
          summary: title,
          status: i <= worktrees ? "In Progress" : "To Do",
          components: [name],
        });
      else
        issueList.push({
          repo: slug,
          number: i,
          title,
          state: "OPEN",
          labels: i % 5 === 0 ? ["bug"] : [],
        });
      if (i > worktrees) continue;
      const branch = jira ? `me/SC-${n}` : `issue-${i}`;
      branchesOf.push(branch);
      if (i % 2 === 1)
        prs.push({
          repo: slug,
          number: 1000 + i,
          branch,
          title: `${title}: the change`,
          body: jira ? `For SC-${n}` : `Closes #${i}`,
          draft: i % 7 === 1,
          review: REVIEW[i % REVIEW.length],
          checks: CHECKS[i % CHECKS.length],
          state: "OPEN",
          unresolved: i % 3 === 0 ? 2 : 0,
        });
    }
    return { name, slug, worktrees: branchesOf, branches: [] };
  });
  for (let k = 0; k < reviews; k++) {
    const r = k % repos;
    prs.push({
      repo: `scale/${names[r]}`,
      number: 5000 + k,
      branch: `dev${k % 9}/change-${k}`,
      title: `Review me: change ${k}`,
      body: "",
      author: `dev${k % 9}`,
      draft: false,
      review: "REVIEW_REQUIRED",
      checks: CHECKS[k % CHECKS.length],
      state: "OPEN",
      unresolved: 0,
      additions: 10 + k,
      deletions: k % 13,
      requested: [{ minutesAgo: 5 + ((k * 37) % 5000) }],
    });
  }
  const settings = jira
    ? {
        tracker: "jira",
        branch: "me/{ref}",
        worktreeDir: ".worktrees",
        githubOwners: ["scale"],
        repoRules: names.map((name) => ({
          component: name,
          repo: `scale/${name}`,
        })),
        jira: {
          transitions: {
            start: "In Progress",
            review: "In Review",
            done: "Resolved",
          },
        },
      }
    : { tracker: "github", branch: "{ref}", worktreeDir: ".worktrees" };
  return {
    settings,
    repos: repoList,
    uncloned: [],
    ...(jira ? { tickets } : { issues: issueList }),
    prs,
  };
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k.startsWith("--") || argv[i + 1] === undefined) {
      console.error(`gen-scale-fixture: bad argument ${k}`);
      process.exit(2);
    }
    out[k.slice(2)] = argv[i + 1];
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const a = parseArgs(process.argv.slice(2));
  /** @param {string} k @param {number} d */
  const num = (k, d) => (a[k] === undefined ? d : Number(a[k]));
  const json = `${JSON.stringify(
    scaleFixture({
      tracker: a.tracker === "jira" ? "jira" : "github",
      repos: num("repos", 50),
      worktrees: num("worktrees", 20),
      issues: num("issues", 2000),
      reviews: num("reviews", 50),
    }),
    null,
    1,
  )}\n`;
  if (a.out) fs.writeFileSync(a.out, json);
  else process.stdout.write(json);
}
