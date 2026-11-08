// GitHub issues (acme/storage#5, a fresh issue).
import assert from "node:assert/strict";
import { flow } from "./flow.mjs";

const issue = (s) => s.issues.find((i) => i.repo === "acme/storage" && i.number === 5);

flow({
  tracker: "github",
  filter: "Stream large files",
  ref: "issue-5",
  repo: "storage",
  worktree: "storage/.worktrees/issue-5",
  branch: "issue-5",
  ticketUrl: "https://github.com/acme/storage/issues/5",
  task: /Task: Work on .*Stream large files/,
  started: (s) => assert.equal(issue(s).state, "OPEN"),
  ticketDone: (s) => issue(s).state === "CLOSED",
});
