// Fee module selection. A Reward token market names its module in the token's
// metadata JSON (written once at launch; its URI is in the base mint's Metaplex
// metadata account):
//   "sonata": { "feeModel": "holders" | "buyback" | "topBuyers" | "lpFarm" | "split" | "diamond", "split": [...] }
// The crank reads it once per pool and caches it in market_fee_models. A model
// that is missing or unknown in JSON that was read, or a token whose metadata
// has no uri (or one off Sonata's profile locations), means "holders", the
// original behaviour, and is cached. Nothing else is cached as holders at once:
//   - a transient failure (network, timeout, HTTP 5xx/408/429, RPC) is read
//     again every pass, so a network blip can never pay a buyback token's pot
//     to its holders;
//   - a failure that may or may not last (HTTP 4xx, a body that is not JSON or
//     not the JSON Sonata uploaded, no metadata account yet) is read again every
//     pass too, and only once it has kept failing for FALLBACK_AFTER_MS (first
//     failure recorded by the ledger's feeModelFailure) is the market cached as
//     holders, with a log line saying so.
// Meanwhile the market waits: its funds stay owed.
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { METADATA_PROGRAM, errText } from "./common.mjs";

export const FEE_MODELS = ["holders", "buyback", "topBuyers", "lpFarm", "split", "diamond"];
export const DEFAULT_FEE_MODEL = "holders";
// Where Sonata profiles live (as lib/token-profile.ts PROFILE_HOSTS).
export const METADATA_PREFIXES = [
  "https://d3lwm4c3ge2mv2.cloudfront.net/tokens/",
  "https://devnet.irys.xyz/",
  "https://gateway.irys.xyz/",
];
export const MAX_METADATA_BYTES = 20 * 1024;
export const USER_AGENT = "SonataPayoutBot/1.0 (+https://sonata.umin.ai)";
// How long a read that may not be permanent keeps being retried before the
// market falls back to holders.
export const FALLBACK_AFTER_MS = 24 * 60 * 60_000;
// Sonata's CDN names each object by the SHA-256 of its bytes
// (lib/server/s3-upload.ts objectKey), so a profile there is checked against
// its name. Irys ids are content-addressed by Irys itself.
const CDN_PREFIX = METADATA_PREFIXES[0];
const CDN_KEY = /^\/tokens\/([0-9a-f]{64})\.json$/;
const MAX_REDIRECTS = 3;
const MAX_STRING = 200;

export const metadataAddress = (mint) =>
  PublicKey.findProgramAddressSync([Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), mint.toBuffer()], METADATA_PROGRAM)[0];

/**
 * The uri of a Metaplex metadata account (key, update authority, mint, then
 * borsh strings name, symbol, uri), or { note } when there is none to read.
 * `empty` marks a readable account whose uri is empty (the token has no
 * profile, for good); every other note may be a read that is not final yet.
 */
export function metadataUri(info, mint) {
  if (!info) return { note: "no Metaplex metadata account" };
  if (!info.owner.equals(METADATA_PROGRAM)) return { note: "metadata account not owned by Metaplex" };
  const data = Buffer.from(info.data);
  // Key::MetadataV1 = 4.
  if (data.length < 69 || data[0] !== 4 || !new PublicKey(data.subarray(33, 65)).equals(mint))
    return { note: "not this mint's metadata account" };
  let at = 65;
  const read = () => {
    if (at + 4 > data.length) throw Error("truncated");
    const length = data.readUInt32LE(at);
    at += 4;
    if (length > MAX_STRING || at + length > data.length) throw Error("string too long");
    const text = data.subarray(at, at + length).toString("utf8").replace(/\0/g, "").trim();
    at += length;
    return text;
  };
  try {
    read(); // name
    read(); // symbol
    const uri = read();
    return uri ? { uri } : { note: "metadata has no uri", empty: true };
  } catch (e) {
    return { note: `unreadable metadata account (${errText(e)})` };
  }
}

/** The URL if it is https on one of Sonata's profile locations, else null. */
export function allowedMetadataUrl(value) {
  if (typeof value !== "string" || value.length > 300) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
  const href = `${url.origin}${url.pathname}`;
  if (!METADATA_PREFIXES.some((p) => href.startsWith(p) && href.length > p.length)) return null;
  // On the CDN only content-addressed profiles: tokens/<sha256>.json.
  if (href.startsWith(CDN_PREFIX) && !CDN_KEY.test(url.pathname)) return null;
  return url;
}

/**
 * A failed metadata read. `permanent`: the token has no Sonata profile, cache
 * holders now. `suspect`: it may or may not last, retried for
 * FALLBACK_AFTER_MS. Neither: transient, retried every pass.
 */
export class MetadataError extends Error {
  constructor(message, { permanent = false, suspect = false } = {}) {
    super(message);
    this.permanent = permanent;
    this.suspect = suspect;
  }
}
const suspect = (message) => new MetadataError(message, { suspect: true });

async function readCapped(res, maxBytes) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw suspect(`metadata JSON is larger than ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    if (e instanceof MetadataError) throw e;
    throw new MetadataError(`metadata read failed: ${errText(e)}`);
  }
  return Buffer.concat(chunks);
}

/**
 * The token's metadata JSON over HTTPS, at most maxBytes, following at most
 * three redirects and only within the allowed locations. A profile on Sonata's
 * CDN must hash to its name. Throws MetadataError (see its kinds).
 */
export async function fetchMetadata(uri, { fetchImpl = globalThis.fetch, timeoutMs = 10_000, maxBytes = MAX_METADATA_BYTES } = {}) {
  let url = allowedMetadataUrl(uri);
  if (!url) throw new MetadataError("metadata uri is not on a Sonata profile location", { permanent: true });
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await fetchImpl(url.href, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new MetadataError(`metadata fetch failed: ${errText(e)}`);
    }
    const drain = () => res.body?.cancel?.().catch(() => {});
    if (res.status >= 300 && res.status < 400) {
      await drain();
      const location = res.headers.get("location");
      let next = null;
      try {
        if (location) next = allowedMetadataUrl(new URL(location, url).href);
      } catch {
        // an unparseable location is refused like a foreign one
      }
      if (!next) throw suspect("metadata redirects off the Sonata profile locations");
      if (hop >= MAX_REDIRECTS) throw suspect("metadata redirects too many times");
      url = next;
      continue;
    }
    if (!res.ok) {
      await drain();
      // A CDN or firewall can answer 403 or 404 for a while (a new object, a
      // blocked address), so no status is taken as final; 5xx, 408 and 429 are
      // plainly passing.
      const passing = res.status >= 500 || res.status === 408 || res.status === 429;
      throw passing ? new MetadataError(`metadata HTTP ${res.status}`) : suspect(`metadata HTTP ${res.status}`);
    }
    if (Number(res.headers.get("content-length")) > maxBytes) {
      await drain();
      throw suspect(`metadata JSON is larger than ${maxBytes} bytes`);
    }
    const bytes = await readCapped(res, maxBytes);
    const key = url.href.startsWith(CDN_PREFIX) ? CDN_KEY.exec(url.pathname)?.[1] : null;
    if (key && createHash("sha256").update(bytes).digest("hex") !== key)
      throw suspect("metadata does not match its content-addressed name");
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      // A firewall challenge page answers 2xx with HTML.
      throw suspect("metadata is not valid JSON");
    }
  }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * { feeModel, config, note } from a metadata JSON. config keeps the split's raw
 * recipients, validated each time they are used (modules/split.mjs).
 */
export function parseFeeModel(json) {
  const holders = (note) => ({ feeModel: DEFAULT_FEE_MODEL, config: null, note });
  if (!isObject(json)) return holders("metadata JSON is not an object");
  const s = json.sonata;
  if (!isObject(s)) return holders("no sonata settings in the metadata");
  if (typeof s.feeModel !== "string") return holders("no sonata.feeModel in the metadata");
  if (!FEE_MODELS.includes(s.feeModel)) return holders(`unknown fee model ${JSON.stringify(s.feeModel.slice(0, 32))}`);
  if (s.feeModel === "split") return { feeModel: "split", config: { split: s.split ?? null }, note: null };
  return { feeModel: s.feeModel, config: null, note: null };
}

/**
 * The fee model of every market: from the cache, else read from chain and the
 * metadata JSON and cached (not in a dry run). Returns a Map of pool →
 * { feeModel, config, uri, note } or { error } when it could not be read this
 * pass. Uncached pools cost one batched RPC call and one HTTPS request each.
 * A read that may not be final is recorded with ledger.feeModelFailure(pool,
 * reason) → { firstFailedAt, elapsedMs } (indexer/modules/crank-schema.mjs);
 * without it such a market is simply retried every pass.
 */
export async function resolveFeeModels({ markets, ledger, fetchAll, fetchImpl, dryRun = false, log = () => {}, deadline = Infinity }) {
  const pools = markets.map((m) => m.pool.toBase58());
  const cached = await ledger.feeModels(pools);
  const out = new Map();
  const todo = [];
  for (const m of markets) {
    const pool = m.pool.toBase58();
    if (cached.has(pool)) out.set(pool, cached.get(pool));
    else todo.push(m);
  }
  if (!todo.length) return out;
  let infos;
  try {
    infos = await fetchAll(todo.map((m) => metadataAddress(m.baseMint)));
  } catch (e) {
    for (const m of todo) out.set(m.pool.toBase58(), { error: `metadata account: ${errText(e)}` });
    return out;
  }
  // A read that may not be final: recorded, and retried (null returned, the
  // pool's { error } set) until it has failed for FALLBACK_AFTER_MS; then the
  // holders entry to cache.
  const unreadable = async (pool, uri, reason) => {
    let since = null;
    if (!dryRun && ledger.feeModelFailure) {
      try {
        since = await ledger.feeModelFailure(pool, reason);
      } catch (e) {
        reason = `${reason}; not recorded: ${errText(e)}`;
      }
    }
    const firstFailedAt = since?.firstFailedAt?.toISOString();
    if (since && since.elapsedMs >= FALLBACK_AFTER_MS) {
      log("feemodel", { pool, uri: uri ?? undefined, model: DEFAULT_FEE_MODEL, result: "fallback", reason, firstFailedAt, note: "unreadable for 24 hours; holders from now on" });
      return { feeModel: DEFAULT_FEE_MODEL, config: null, uri, note: `unreadable since ${firstFailedAt} (${reason}); holders fallback` };
    }
    out.set(pool, { error: reason, ...(firstFailedAt ? { firstFailedAt } : {}) });
    log("feemodel", { pool, uri: uri ?? undefined, result: "unread", reason, firstFailedAt, note: "retried next pass, for up to 24 hours; funds stay owed" });
    return null;
  };
  for (const [i, m] of todo.entries()) {
    const pool = m.pool.toBase58();
    let entry;
    const { uri, note, empty } = metadataUri(infos[i], m.baseMint);
    if (empty) entry = { feeModel: DEFAULT_FEE_MODEL, config: null, uri: null, note };
    // No readable metadata account: an RPC node can lag behind the one that listed the treasury.
    else if (!uri) {
      entry = await unreadable(pool, null, note);
      if (!entry) continue;
    } else if (Date.now() > deadline) {
      out.set(pool, { error: "pass time budget used" });
      continue;
    } else {
      try {
        entry = { ...parseFeeModel(await fetchMetadata(uri, { fetchImpl })), uri };
      } catch (e) {
        if (e instanceof MetadataError && e.permanent) entry = { feeModel: DEFAULT_FEE_MODEL, config: null, uri, note: errText(e) };
        else if (e instanceof MetadataError && e.suspect) {
          entry = await unreadable(pool, uri, errText(e));
          if (!entry) continue;
        } else {
          out.set(pool, { error: errText(e) });
          log("feemodel", { pool, uri, result: "unread", reason: errText(e), note: "retried next pass; funds stay owed" });
          continue;
        }
      }
    }
    let result = dryRun ? "read" : "cached";
    try {
      if (!dryRun) await ledger.saveFeeModel({ pool, ...entry });
    } catch (e) {
      // Used this pass anyway (the metadata is immutable) and read again next pass.
      result = `read; not cached: ${errText(e)}`;
    }
    out.set(pool, entry);
    log("feemodel", { pool, model: entry.feeModel, uri: entry.uri ?? undefined, note: entry.note ?? undefined, result });
  }
  return out;
}
