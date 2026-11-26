@AGENTS.md

## Commands

```sh
npm run build       # src/ -> mods/; run after any src/ change and commit mods/
npm test            # unit tests (node --test, against demo fakes)
npm run typecheck   # tsc --checkJs over JSDoc types
npm run lint        # biome; `npm run format` to auto-fix
npm run e2e         # real Herdr, Linux/Xvfb only (nix develop .#e2e)
```

- New worktree: run `npm ci` first (tsc, biome and ts-json-schema-generator are local deps).
- `check-built` compares both `mods/` and `sheltie.schema.json`; rebuild after editing `src/` (the schema takes its defaults from `src/defaults.js`).
- Edited a shell script (`demo/bin/*`, `demo/herdr-demo`, `demo/state.sh`, `install.sh`, `diagnostics.sh`)? Run `nix shell nixpkgs#shellcheck -c shellcheck -x -e SC2016 -P SCRIPTDIR <files>`, as CI does.

Before pushing, run the same checks CI does: `npm run check-built && npm run typecheck && npm run ci:lint && npm test`.

## Architecture

- `src/*.js`: shared modules. `src/<mod>/`: one Herdr mod each (tickets, work, reviews, projects, usage, layouts).
- `mods/` is **generated**. Never edit it by hand. The build copies each mod plus the shared modules it imports, because Herdr only resolves imports inside a mod's folder.
- Plain JS with JSDoc types (no TS build step). Shared types are in `src/types.js` and `types/`.
- Tests: `tests/register.mjs` swaps the `herdr` import for `tests/herdr-stub.mjs` (and `gpui-*` for `tests/gpui-stub.mjs`); `gh`/`jira` are faked by `demo/bin/*` via `C.programs`; git runs for real on temp repos.
- More detail: `docs/development.md`. Vocabulary: `GLOSSARY.md`.

## Known test noise

- `limits.test.mjs` "planLimits: without claude installed" fails locally on macOS (#280). Ignore it unless you touched `src/limits.js`.
- Flaky in CI: `github.test.mjs` "workFor: branches by name…" and the e2e Draft PR button race. Rerun before debugging.
