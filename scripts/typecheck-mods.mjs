// npm run typecheck:mods — type checks the built mods/ as Herdr loads them.
// Each mod's folder is staged with the shared modules its JSDoc imports (the
// build copies only runtime imports) and types/, then checked with tsconfig.mods.json.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const stage = path.join(root, "node_modules", ".cache", "typecheck-mods");
fs.rmSync(stage, { recursive: true, force: true });
for (const mod of fs.readdirSync(path.join(root, "mods"))) {
  const out = path.join(stage, mod);
  fs.cpSync(path.join(root, "mods", mod), out, { recursive: true });
  // The shared modules, for the typings the mods import in JSDoc (src/types.js
  // imports config.js that way). The build copies only the runtime imports.
  for (const shared of fs.readdirSync(path.join(root, "src"))) {
    if (shared.endsWith(".js"))
      fs.copyFileSync(path.join(root, "src", shared), path.join(out, shared));
  }
}
// The mods' "../types/settings.js" imports resolve to stage/types/.
fs.cpSync(path.join(root, "types"), path.join(stage, "types"), {
  recursive: true,
});

const tsc = path.join(root, "node_modules", ".bin", "tsc");
const run = spawnSync(tsc, ["-p", path.join(root, "tsconfig.mods.json")], {
  stdio: "inherit",
});
process.exitCode = run.status ?? 1;
