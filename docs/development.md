# Development

```sh
npm run build      # src/ -> mods/ (commit the result)
npm test           # node --test against throwaway demos
npm run e2e        # the real Herdr with the mods, on throwaway demos
npm run e2e:shots  # screenshots of the mods at a few sizes, in e2e-results/shots/
npm run ci:lint    # Biome lint and format check, exactly as CI runs it
npm run format     # apply Biome's fixes and formatting
```

Run these inside `nix develop` (on NixOS npm's Biome binary won't start; the
shell points `BIOME_BINARY` at Nix's), or elsewhere after `npm ci`, so the
pinned `@biomejs/biome` is used rather than another `biome` on your PATH.

## Layout

`src/` holds the shared modules (`config.js`, `lib.js`, `git.js`, `prs.js`,
`work.js`, `flow.js`, `tracker*.js`, `usage.js`) and each mod's own `main.js`
and `mod.json`. Herdr only resolves imports inside a mod's folder, so the build copies into each
`mods/<name>/` the shared modules it imports. `herdr-app check mods/<name>`
(with Herdr running) loads a mod once; it leaves `gpui-kit.d.ts` and
`jsconfig.json` in the folder, which `npm run build` removes.

A new tracker is a `src/tracker-<name>.js` with the functions listed in
`src/tracker.js`, added to its `trackers` map.

## End-to-end tests

`npm run e2e` launches Herdr on the demo, once per tracker, on its own Xvfb
display (with its own app home and herdr-core session, so your Herdr is
untouched), and drives it with the keyboard. It checks that the mods load
without errors, a fresh ticket starts from the tickets popup, its repo's hub
row opens a space of its own, and its whole flow runs from the Work sidebar's
keys through to Finish. Along the way it opens the row's PR and ticket (with a
stub `xdg-open` that records the URL) and resolves a merge conflict. On Jira,
CI also fails once and Finish refuses uncommitted changes.

It checks outcomes, not pixels: `herdr-app status`, `work.report`, git,
`hc read` and the demo's state. It needs herdr-app, hc, Xvfb, xdotool, jq and
git (Linux), takes under a minute, and cleans up after itself. A failed step
leaves a screenshot, the app log and the state in `e2e-results/`.
`nix develop .#e2e -c npm run e2e` brings all of that, with Herdr from the
nixpkgs pinned in `flake.lock`.

`npm run e2e:shots` (same needs) saves screenshots of the Work sidebar, from
the folded rail to wide, and of the tickets and projects popups. It covers a
small, a default and a large window, light and dark, at zoom 1, 1.5 and 2, on
the Jira demo with its long ticket, branch and repo names. They're for looking
at after a Herdr update or a UI change; the run itself only checks there are
no errors and the sidebar still offers every step.

## CI

CI checks that `mods/` is up to date, runs `npm run ci:lint`, ShellCheck and the tests, and runs
the end-to-end tests on pull requests and pushes to main against
herdr-desktop 0.1.10 and herdr-core 0.1.15 (update `flake.lock` to move on),
and weekly against the newest Herdr in nixos-unstable. A failed run uploads
`e2e-results/` as an artifact, and the screenshots are kept as the
`e2e-shots` artifact.

## Demo commands

```sh
demo/herdr-demo comment WEB-105          # play a reviewer
demo/herdr-demo request-changes WEB-105
demo/herdr-demo approve WEB-105
demo/herdr-demo fail-ci WEB-105
demo/herdr-demo conflict WEB-105         # conflict with main
demo/herdr-demo status
```

The demo uses its own app home and herdr-core session, so your spaces and
settings are untouched.
