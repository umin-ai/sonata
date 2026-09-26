// Module resolution for running the app's TypeScript modules in Node without a
// build step: extensionless relative imports resolve to .ts or .tsx, "@/..."
// resolves to the web root, JSON loads with the import attribute Node requires,
// and "server-only" (a Vite build guard) is an empty module. Nothing else
// changes; the app build never uses this file.
//
// Used by the tests (scripts/test-register.mjs registers it for node:test) and
// by the indexer's live push (indexer/index.mjs registers it before importing
// lib/treasury/snapshot-decode.ts, the market list's decoder). Both run Node
// with --experimental-strip-types.
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB_ROOT = new URL("../", import.meta.url);
const EMPTY = "data:text/javascript,export {};";

const isFile = (path) => existsSync(path) && statSync(path).isFile();

export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: EMPTY, shortCircuit: true };
  let spec = specifier;
  if (spec.startsWith("@/")) spec = new URL(spec.slice(2), WEB_ROOT).href;
  const relative = spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("file:");
  if (relative && (context.parentURL || spec.startsWith("file:"))) {
    const url = new URL(spec, context.parentURL);
    const path = fileURLToPath(url);
    if (!isFile(path))
      for (const ext of [".ts", ".tsx", "/index.ts"])
        if (isFile(path + ext)) return next(pathToFileURL(path + ext).href, context);
    if (path.endsWith(".json"))
      return next(url.href, { ...context, importAttributes: { ...context.importAttributes, type: "json" } });
    return next(url.href, context);
  }
  return next(spec, context);
}

export async function load(url, context, next) {
  if (url.endsWith(".json")) return next(url, { ...context, importAttributes: { ...context.importAttributes, type: "json" } });
  return next(url, context);
}
