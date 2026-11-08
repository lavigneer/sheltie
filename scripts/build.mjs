// Builds mods/<name>/ from src/: each mod's own files plus a copy of the shared
// modules it imports (directly or through another shared module). Herdr only resolves imports inside a mod's folder, so installing is
// copying these folders. Run after changing src/; CI checks mods/ is current.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const src = path.join(root, "src");
const shared = new Set(fs.readdirSync(src).filter((f) => f.endsWith(".js")));
const importsOf = (file) =>
  [...fs.readFileSync(file, "utf8").matchAll(/from\s+"\.\/([\w.-]+\.js)"/g)]
    .map((m) => m[1])
    .filter((f) => shared.has(f));
const mods = fs
  .readdirSync(src, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

fs.rmSync(path.join(root, "mods"), { recursive: true, force: true });
for (const mod of mods) {
  const out = path.join(root, "mods", mod);
  fs.mkdirSync(out, { recursive: true });
  const own = fs.readdirSync(path.join(src, mod));
  for (const f of own)
    fs.copyFileSync(path.join(src, mod, f), path.join(out, f));
  const needed = new Set();
  const todo = own
    .filter((f) => f.endsWith(".js"))
    .flatMap((f) => importsOf(path.join(src, mod, f)));
  while (todo.length) {
    const f = todo.pop();
    if (needed.has(f)) continue;
    needed.add(f);
    todo.push(...importsOf(path.join(src, f)));
  }
  for (const f of needed) fs.copyFileSync(path.join(src, f), path.join(out, f));
}
console.log(`built ${mods.length} mods: ${mods.join(", ")}`);
