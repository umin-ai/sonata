// Fee module selection. A Reward token market names its module in the token's
// metadata JSON (written once at launch; its URI is in the base mint's Metaplex
// metadata account):
//   "sonata": { "feeModel": "holders" | "buyback" | "topBuyers" | "lpFarm" | "split" | "diamond", "split": [...] }
// The crank reads it once per pool and caches it in market_fee_models. A
// missing, unreadable or unknown model means "holders", the original
// behaviour. Only a transient failure (network, timeout, HTTP 5xx/408/429, RPC)
// is not cached: that market waits (its funds stay owed) and is read again next
// pass, so a network blip can never pay a buyback token's pot to its holders.
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
const MAX_REDIRECTS = 3;
const MAX_STRING = 200;

export const metadataAddress = (mint) =>
  PublicKey.findProgramAddressSync([Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), mint.toBuffer()], METADATA_PROGRAM)[0];

/**
 * The uri of a Metaplex metadata account (key, update authority, mint, then
 * borsh strings name, symbol, uri), or { note } when there is none to read.
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
    return uri ? { uri } : { note: "metadata has no uri" };
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
  return METADATA_PREFIXES.some((p) => href.startsWith(p) && href.length > p.length) ? url : null;
}

export class MetadataError extends Error {
  constructor(message, permanent) {
    super(message);
    this.permanent = permanent;
  }
}

async function readCapped(res, maxBytes) {
  if (!res.body) return "";
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
        throw new MetadataError(`metadata JSON is larger than ${maxBytes} bytes`, true);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    if (e instanceof MetadataError) throw e;
    throw new MetadataError(`metadata read failed: ${errText(e)}`, false);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The token's metadata JSON over HTTPS, at most maxBytes, following at most
 * three redirects and only within the allowed locations. Throws MetadataError;
 * `permanent` says whether the failure is worth caching.
 */
export async function fetchMetadata(uri, { fetchImpl = globalThis.fetch, timeoutMs = 10_000, maxBytes = MAX_METADATA_BYTES } = {}) {
  let url = allowedMetadataUrl(uri);
  if (!url) throw new MetadataError("metadata uri is not on a Sonata profile location", true);
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await fetchImpl(url.href, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new MetadataError(`metadata fetch failed: ${errText(e)}`, false);
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
      if (!next) throw new MetadataError("metadata redirects off the Sonata profile locations", true);
      if (hop >= MAX_REDIRECTS) throw new MetadataError("metadata redirects too many times", true);
      url = next;
      continue;
    }
    if (!res.ok) {
      await drain();
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      throw new MetadataError(`metadata HTTP ${res.status}`, permanent);
    }
    if (Number(res.headers.get("content-length")) > maxBytes) {
      await drain();
      throw new MetadataError(`metadata JSON is larger than ${maxBytes} bytes`, true);
    }
    const text = await readCapped(res, maxBytes);
    try {
      return JSON.parse(text);
    } catch {
      throw new MetadataError("metadata is not valid JSON", true);
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
  for (const [i, m] of todo.entries()) {
    const pool = m.pool.toBase58();
    let entry;
    const { uri, note } = metadataUri(infos[i], m.baseMint);
    if (!uri) entry = { feeModel: DEFAULT_FEE_MODEL, config: null, uri: null, note };
    else if (Date.now() > deadline) {
      out.set(pool, { error: "pass time budget used" });
      continue;
    } else {
      try {
        entry = { ...parseFeeModel(await fetchMetadata(uri, { fetchImpl })), uri };
      } catch (e) {
        if (!(e instanceof MetadataError) || !e.permanent) {
          out.set(pool, { error: errText(e) });
          log("feemodel", { pool, uri, result: "unread", reason: errText(e), note: "retried next pass; funds stay owed" });
          continue;
        }
        entry = { feeModel: DEFAULT_FEE_MODEL, config: null, uri, note: errText(e) };
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
