// node --import ./tests/register.mjs: resolves "herdr" to the stub.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(spec, ctx, next) {
        if (spec === "herdr")
          return { url: ${JSON.stringify(new URL("./herdr-stub.mjs", import.meta.url).href)}, shortCircuit: true };
        return next(spec, ctx);
      }`),
);
