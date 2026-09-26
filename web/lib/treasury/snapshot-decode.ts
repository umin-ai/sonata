// The market list's decoder: the listed markets and their card numbers from
// an indexer answer of raw accounts (/api/index/accounts), checked with the
// browser's own code (treasuryEntries, marketsFromAccounts,
// treasuryFromAccounts), so the listing rule and the card checks are the same
// ones everywhere. Shared by the app's server (lib/server/market-snapshot.ts)
// and the indexer's live push (indexer/modules/market-store.mjs, which runs it
// in Node through scripts/node-hooks.mjs), so it must not import "server-only".
import { Buffer } from "buffer";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { cardsFromAccounts, identityOf, metadataAddress, treasuryEntries } from "./runtime";
import {
  newestFirst,
  type SkippedMarket,
  type SnapshotEntry,
  type StreamPosition,
} from "./market-snapshot";

export type RawAccount = { owner: string; lamports: number; executable: boolean; data: string; slot: number } | null;
/** The indexer's /api/index/accounts answer. */
export type RawMarketAccounts = {
  v: 1;
  readAt: number;
  slot: number;
  treasuries: string[];
  accounts: Record<string, RawAccount>;
  /**
   * With live push (indexer/modules/market-store.mjs): the stream position
   * the answer was taken at, and the entries the indexer decoded with this
   * same function at that position.
   */
  epoch?: string;
  seq?: number;
  liveAt?: number;
  entries?: SnapshotEntry[];
  skipped?: SkippedMarket[];
};
type Info = AccountInfo<Buffer> | null;

/**
 * The listed markets and their card numbers from the indexer's raw accounts,
 * checked with the browser's code, newest first. An account the indexer did
 * not read fails that market (it shows an error), never the list. Each entry
 * carries its launch time and its version: the newest slot among the
 * accounts it was decoded from.
 */
export function snapshotFromAccounts(raw: RawMarketAccounts) {
  if (
    raw?.v !== 1 ||
    typeof raw.readAt !== "number" ||
    !Array.isArray(raw.treasuries) ||
    !raw.accounts ||
    typeof raw.accounts !== "object"
  )
    throw Error("Unexpected market accounts answer.");
  const decoded = new Map<string, Info>();
  const info = (key: string): Info => {
    if (decoded.has(key)) return decoded.get(key)!;
    if (!Object.hasOwn(raw.accounts, key)) throw Error(`Account ${key} was not read.`);
    const a = raw.accounts[key];
    const value =
      a &&
      ({
        owner: new PublicKey(a.owner),
        lamports: Number(a.lamports),
        executable: a.executable === true,
        data: Buffer.from(String(a.data), "base64"),
        rentEpoch: 0,
      } as AccountInfo<Buffer>);
    decoded.set(key, value);
    return value;
  };
  const slotOf = (key: string) => {
    const slot = Object.hasOwn(raw.accounts, key) ? raw.accounts[key]?.slot : undefined;
    return typeof slot === "number" && Number.isFinite(slot) ? slot : null;
  };
  const listed = treasuryEntries(
    raw.treasuries.filter((k) => typeof k === "string"),
    info,
  );
  const { cards, skipped } = cardsFromAccounts(listed.entries, info, (k) => slotOf(k) ?? raw.slot);
  const entries = cards.map((c): SnapshotEntry => {
    const m = c.market;
    // The accounts the card was decoded from (runtime.ts cardKeys, plus the shared quote mint and program).
    const keys = [m.pool, m.config, metadataAddress(m.baseMint).toBase58(), m.treasury, m.baseMint, m.treasuryQuote, m.payoutQuote, m.quoteMint, m.programId];
    const slots = keys.map(slotOf).filter((s): s is number => s !== null);
    return {
      market: identityOf(m),
      data: c.data,
      ...(c.error ? { error: c.error } : {}),
      ...(c.launchedAt !== undefined ? { launchedAt: c.launchedAt } : {}),
      ...(slots.length ? { version: Math.max(...slots) } : {}),
    };
  });
  return {
    readAt: raw.readAt,
    slot: Number(raw.slot) || 0,
    entries: entries.sort(newestFirst),
    skipped: [...listed.skipped, ...skipped],
  };
}

/** The answer's live stream position, when the indexer pushes live updates. */
export function streamOf(raw: Pick<RawMarketAccounts, "epoch" | "seq">): StreamPosition | null {
  return typeof raw?.epoch === "string" && /^[0-9a-z]{1,16}$/.test(raw.epoch) && Number.isSafeInteger(raw.seq) && raw.seq! >= 0
    ? { epoch: raw.epoch, seq: raw.seq! }
    : null;
}

/**
 * The entries the indexer decoded (with this module's snapshotFromAccounts)
 * when the answer carries them and they are well formed, newest first; else
 * null, and the caller decodes the raw accounts itself.
 */
export function decodedByIndexer(raw: RawMarketAccounts) {
  if (!Array.isArray(raw?.entries) || !Array.isArray(raw.skipped) || typeof raw.readAt !== "number") return null;
  const wellFormed = (e: unknown): e is SnapshotEntry => {
    if (!e || typeof e !== "object") return false;
    const x = e as SnapshotEntry;
    return (
      !!x.market &&
      typeof x.market.pool === "string" &&
      typeof x.market.symbol === "string" &&
      (x.data === null || (typeof x.data === "object" && typeof x.data.slot === "number"))
    );
  };
  if (!raw.entries.every(wellFormed)) return null;
  return {
    readAt: raw.readAt,
    slot: Number(raw.slot) || 0,
    entries: [...raw.entries].sort(newestFirst),
    skipped: raw.skipped.filter((s) => s && typeof s.pool === "string"),
  };
}
