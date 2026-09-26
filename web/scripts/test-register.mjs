// node --import ./scripts/test-register.mjs: module resolution for app modules in tests (scripts/node-hooks.mjs).
import { register } from "node:module";

register("./node-hooks.mjs", import.meta.url);
