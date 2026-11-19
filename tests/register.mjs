// node --import ./tests/register.mjs: resolves "herdr" (and the gpui modules
// a mod draws with) to the stubs.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(spec, ctx, next) {
        if (spec === "herdr")
          return { url: ${JSON.stringify(new URL("./herdr-stub.mjs", import.meta.url).href)}, shortCircuit: true };
        if (spec === "gpui-base" || spec === "gpui-kit")
          return { url: ${JSON.stringify(new URL("./gpui-stub.mjs", import.meta.url).href)}, shortCircuit: true };
        return next(spec, ctx);
      }`),
);
