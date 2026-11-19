@AGENTS.md

## Commands

```sh
npm run build       # src/ -> mods/; run after any src/ change and commit mods/
npm test            # unit tests (node --test, against demo fakes)
npm run typecheck   # tsc --checkJs over JSDoc types
npm run lint        # biome; `npm run format` to auto-fix
npm run e2e         # real Herdr, Linux/Xvfb only (nix develop .#e2e)
```

Before pushing, run the same checks CI does: `npm run check-built && npm run typecheck && npm run ci:lint && npm test`.

## Architecture

- `src/*.js`: shared modules. `src/<mod>/`: one Herdr mod each (tickets, work, reviews, projects, usage, layouts).
- `mods/` is **generated**. Never edit it by hand. The build copies each mod plus the shared modules it imports, because Herdr only resolves imports inside a mod's folder.
- Plain JS with JSDoc types (no TS build step). Shared types are in `src/types.js` and `types/`.
- More detail: `docs/development.md`. Vocabulary: `GLOSSARY.md`.
