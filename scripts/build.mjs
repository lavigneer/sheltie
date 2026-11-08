// Builds mods/<name>/ from src/: each mod's own files plus a copy of the shared
// modules. Herdr only resolves imports inside a mod's folder, so installing is
// copying these folders. Run after changing src/; CI checks mods/ is current.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = path.join(root, "src");
const shared = fs.readdirSync(src).filter((f) => f.endsWith(".js"));
const mods = fs
  .readdirSync(src, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

fs.rmSync(path.join(root, "mods"), { recursive: true, force: true });
for (const mod of mods) {
  const out = path.join(root, "mods", mod);
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(path.join(src, mod)))
    fs.copyFileSync(path.join(src, mod, f), path.join(out, f));
  for (const f of shared) fs.copyFileSync(path.join(src, f), path.join(out, f));
}
console.log(`built ${mods.length} mods: ${mods.join(", ")}`);
