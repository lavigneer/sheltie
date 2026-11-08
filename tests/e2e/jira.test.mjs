// Jira (WEB-105, a fresh ticket whose component maps to acme/storage), with
// the failure paths: CI fails once, Finish refuses uncommitted changes.
import assert from "node:assert/strict";
import { flow } from "./flow.mjs";

const ticket = (s) => s.tickets.find((t) => t.key === "WEB-105");

flow(
  {
    tracker: "jira",
    filter: "WEB-105",
    ref: "WEB-105",
    repo: "storage",
    worktree: "storage/.claude/worktrees/WEB-105",
    branch: "me/WEB-105",
    ticketUrl: "https://jira.example.invalid/browse/WEB-105",
    task: /Task: Work on WEB-105: Storage: stream large files/,
    started: (s) => assert.equal(ticket(s).status, "In Progress"),
    inReview: (s) => assert.equal(ticket(s).status, "In Review"),
    ticketDone: (s) => ticket(s).status === "Resolved",
  },
  { failures: true },
);
