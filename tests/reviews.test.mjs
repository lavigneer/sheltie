// The review queue (prs.js reviewQueue): known repos only, oldest request
// first, dropped once reviewed unless re-requested.
import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewQueue } from "../src/prs.js";

const pr = (
  slug,
  number,
  { asked = [], reviewed = [], createdAt = "2026-01-01T00:00:00Z" } = {},
) => ({
  number,
  url: `https://github.com/${slug}/pull/${number}`,
  title: `PR ${number}`,
  additions: 10,
  deletions: 2,
  createdAt,
  repository: { nameWithOwner: slug },
  author: { login: "someone" },
  timelineItems: {
    nodes: asked.map(([who, at]) => ({
      createdAt: at,
      requestedReviewer:
        who === "team"
          ? { __typename: "Team" }
          : { __typename: "User", login: who },
    })),
  },
  latestReviews: {
    nodes: reviewed.map((at) => ({ author: { login: "Me" }, submittedAt: at })),
  },
});
const data = (...nodes) => ({ viewer: { login: "me" }, search: { nodes } });
const keys = (q) => q.map((r) => `${r.slug}#${r.number}`);

test("only PRs in known repos, matched case-insensitively", () => {
  const q = reviewQueue(
    data(
      pr("acme/web", 1, { asked: [["me", "2026-02-01T00:00:00Z"]] }),
      pr("other/x", 2),
    ),
    ["Acme/Web"],
  );
  assert.deepEqual(keys(q), ["acme/web#1"]);
  assert.deepEqual(
    { ...q[0], url: undefined },
    {
      slug: "acme/web",
      number: 1,
      url: undefined,
      title: "PR 1",
      author: "someone",
      requestedAt: "2026-02-01T00:00:00Z",
      additions: 10,
      deletions: 2,
    },
  );
});

test("oldest request first; requests to others don't count", () => {
  const q = reviewQueue(
    data(
      pr("a/b", 1, { asked: [["me", "2026-03-01T00:00:00Z"]] }),
      pr("a/b", 2, {
        asked: [
          ["me", "2026-01-05T00:00:00Z"],
          ["bob", "2026-04-01T00:00:00Z"],
        ],
      }),
      pr("a/b", 3, { asked: [["team", "2026-02-01T00:00:00Z"]] }),
      pr("a/b", 4, { createdAt: "2026-01-02T00:00:00Z" }),
    ),
    ["a/b"],
  );
  assert.deepEqual(keys(q), ["a/b#4", "a/b#2", "a/b#3", "a/b#1"]);
});

test("drops off once reviewed, back when re-requested", () => {
  const q = reviewQueue(
    data(
      pr("a/b", 1, {
        asked: [["me", "2026-01-01T00:00:00Z"]],
        reviewed: ["2026-01-02T00:00:00Z"],
      }),
      pr("a/b", 2, {
        asked: [
          ["me", "2026-01-01T00:00:00Z"],
          ["me", "2026-01-03T00:00:00Z"],
        ],
        reviewed: ["2026-01-02T00:00:00Z"],
      }),
      pr("a/b", 3, {
        asked: [["team", "2026-01-01T00:00:00Z"]],
        reviewed: ["2026-01-02T00:00:00Z"],
      }),
    ),
    ["a/b"],
  );
  assert.deepEqual(keys(q), ["a/b#2"]);
});

test("no answer, no queue", () => {
  assert.deepEqual(reviewQueue(null, ["a/b"]), []);
});
