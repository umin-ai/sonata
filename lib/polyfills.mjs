// SPL Token and Anchor's browser bundles require Buffer during module setup.
import { Buffer } from "buffer";
globalThis.Buffer ??= Buffer;
