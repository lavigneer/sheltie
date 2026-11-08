// `npm run e2e:shots`: screenshots of the mods in the real Herdr, on the Jira
// demo (with its long ticket, branch and repo names), at a few window sizes,
// sidebar widths, zooms and in light and dark, saved to e2e-results/shots/.
// For looking at after a Herdr update or a UI change: like the other
// end-to-end tests it checks outcomes (no errors; the sidebar still offers
// the long row's steps at every size), never pixels.
//
// Not part of `npm run e2e` (it isn't a *.test.mjs); CI runs it after the
// end-to-end tests and keeps the shots as an artifact.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { Herdr, missingTools, RESULTS, waitFor } from "./herdr.mjs";

const OUT = path.join(RESULTS, "shots");
// The demo's row with the longest everything, and the most steps.
const LONG =
  "customer-onboarding-and-billing-service/.claude/worktrees/WEB-106";
const LONG_STEPS = ["fix-ci", "address-comments"];
// Long enough for a frame or two at the new size, zoom or theme.
const SETTLE_MS = 1_200;

const WINDOWS = {
  small: [800, 560],
  default: [1280, 800],
  large: [2200, 1300],
};

// [name, window, sidebar px, settings]: the Work sidebar from the folded
// rail (44) to wide, at the default window, then the other windows, dark and
// zoomed.
const LOOKS = [
  ["rail", "default", 44, {}],
  ["narrow", "default", 160, {}],
  ["slim", "default", 200, {}],
  ["default", "default", 268, {}],
  ["wide", "default", 420, {}],
  ["small-window", "small", 200, {}],
  ["large-window", "large", 268, {}],
  ["dark", "default", 268, { appearance: "dark" }],
  ["dark-narrow", "default", 160, { appearance: "dark" }],
  ["zoom-1.5", "default", 268, { zoom: 1.5 }],
  ["zoom-2-small", "small", 200, { zoom: 2 }],
];
const PLAIN = { appearance: "light", zoom: 1 };

const missing = missingTools();
if (missing.length)
  test("e2e shots", () => assert.fail(`needs ${missing.join(", ")} on PATH`));
else {
  const h = new Herdr("jira");
  const long = () => path.join(h.demo, "ws", LONG);
  const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));
  const look = async (win, sidebar, settings) => {
    await h.settings({ ...PLAIN, ...settings });
    await h.resize(...WINDOWS[win]);
    await h.sh("herdr-app", [
      "do",
      "layout.resize",
      "--id",
      "sidebar",
      "--px",
      String(sidebar),
    ]);
    await settle();
  };
  const shot = (name) => h.shot(path.join(OUT, `${h.tracker}-${name}.png`));

  before(
    async () => {
      fs.rmSync(OUT, { recursive: true, force: true });
      await h.start();
      // The Work block taller than Spaces and Agents, so every demo row shows.
      await h.sh("herdr-app", [
        "do",
        "layout.resize",
        "--id",
        "work-outline",
        "--weight",
        "4",
      ]);
    },
    { timeout: 120_000 },
  );
  after(() => h.stop(), { timeout: 60_000 });

  test("the Work sidebar at every size", { timeout: 180_000 }, async () => {
    await waitFor(
      "the sidebar's first scan",
      async () => (await h.report()).loaded,
    );
    await h.waitRow("the long row's steps", long(), (r) =>
      LONG_STEPS.every((id) => r.steps.some((s) => s.id === id)),
    );
    for (const [name, win, sidebar, settings] of LOOKS) {
      await look(win, sidebar, settings);
      await shot(`work-${name}`);
      await h.assertNoErrors(`showing the sidebar ${name}`);
      const row = await h.row(long());
      assert.deepEqual(
        row?.steps.map((s) => s.id),
        LONG_STEPS,
        `the long row's steps (${name})`,
      );
    }
  });

  test("the tickets and projects popups in a small, default and large window", {
    timeout: 180_000,
  }, async () => {
    for (const [win, settings] of [
      ["small", {}],
      ["default", {}],
      ["large", {}],
      ["default", { appearance: "dark" }],
    ]) {
      const name = `${win}${settings.appearance ? `-${settings.appearance}` : ""}`;
      await look(win, 268, settings);

      await h.key("ctrl+shift+j");
      await waitFor("the tickets popup", async () =>
        (await h.status()).overlays.includes("tickets"),
      );
      await settle();
      await shot(`tickets-${name}`);
      // The long ticket's screen (it has work, so Enter opens it).
      await h.type("WEB-106");
      await settle();
      await h.key("Return");
      await settle();
      await shot(`ticket-${name}`);
      await h.assertNoErrors(`showing the tickets popup ${name}`);
      await h.key("Escape");
      await waitFor(
        "the popup to close",
        async () => !(await h.status()).overlays.includes("tickets"),
      );

      await h.key("ctrl+shift+f");
      await waitFor("the projects popup", async () =>
        (await h.status()).overlays.includes("projects"),
      );
      await settle();
      await shot(`projects-${name}`);
      await h.assertNoErrors(`showing the projects popup ${name}`);
      await h.key("Escape");
      await waitFor(
        "the popup to close",
        async () => !(await h.status()).overlays.includes("projects"),
      );
    }
  });
}
