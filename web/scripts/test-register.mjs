// node --import ./scripts/test-register.mjs: test-only resolution for app modules (scripts/test-hooks.mjs).
import { register } from "node:module";

register("./test-hooks.mjs", import.meta.url);
