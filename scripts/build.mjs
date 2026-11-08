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

// sheltie.schema.json, for editors: the Settings type (types/settings.d.ts)
// with each setting's default from src/defaults.js.
const { createGenerator } = await import("ts-json-schema-generator");
const { DEFAULTS } = await import(path.join(src, "defaults.js"));
const generated = createGenerator({
  path: path.join(root, "types", "settings.d.ts"),
  type: "Settings",
  expose: "none",
  topRef: false,
  jsDoc: "extended",
  skipTypeCheck: true,
}).createSchema("Settings");
const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const withDefaults = (node, value) => {
  if (!isObject(value)) return { ...node, default: value };
  const properties = Object.fromEntries(
    Object.entries(node.properties).map(([k, p]) => [
      k,
      k in value ? withDefaults(p, value[k]) : p,
    ]),
  );
  // Every setting has a default, so none is required in the file.
  const { required: _, ...rest } = node;
  return { ...rest, properties };
};
const { $schema: _draft, ...body } = generated;
const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://raw.githubusercontent.com/lavigneer/sheltie/main/sheltie.schema.json",
  ...withDefaults(body, DEFAULTS),
};
fs.writeFileSync(
  path.join(root, "sheltie.schema.json"),
  `${JSON.stringify(schema, null, 2)}\n`,
);
console.log("built sheltie.schema.json");
