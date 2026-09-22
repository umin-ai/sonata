import "../stockroom/polyfills.mjs";
import * as module from "@coral-xyz/anchor/dist/browser/index.js";
export const browserAnchor = module.Program
  ? module
  : Reflect.get(module, "default");
