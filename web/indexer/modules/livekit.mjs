// Test helpers for live push (market-store, live and stream tests): the app's
// capture of four Devnet markets as a fake RPC, the market accounts reader
// over it, and small edits of pool and token accounts. Not a test file.
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { marketAccountsReader } from "./market-accounts.mjs";

export const fixture = JSON.parse(readFileSync(new URL("../../lib/treasury/fixtures/devnet-markets.json", import.meta.url), "utf8"));
const idl = JSON.parse(readFileSync(new URL("../../lib/treasury/stockroom_treasury.json", import.meta.url), "utf8"));
export const DISCRIMINATOR = idl.accounts.find((a) => a.name === "Treasury").discriminator;
export const QUOTE_MINTS = new Set(
  JSON.parse(readFileSync(new URL("../../lib/treasury/quote-assets.json", import.meta.url), "utf8")).assets.map((a) => a.mint),
);
export const PROGRAM = fixture.treasuryProgram;
export const golden = fixture.golden;
export const bySymbol = (symbol) => golden.markets.find((m) => m.symbol === symbol);

const toInfo = (a) =>
  a && { owner: new PublicKey(a.owner), lamports: a.lamports, executable: a.executable, data: Buffer.from(a.data[0], "base64") };

/**
 * A fake RPC over the fixture. `accounts` (key -> fixture-shaped account)
 * overrides the capture; `treasuries` (pubkeys) limits which treasuries the
 * program lists; `slot` is what every call answers at unless `slots` says
 * otherwise per getMultipleAccounts call. Signatures for addresses come from
 * `signatures` (address -> [{ signature, slot, err, blockTime }], newest first).
 */
export function fakeRpc({ slot = fixture.slot } = {}) {
  const chain = {
    slot,
    accounts: new Map(Object.entries(fixture.accounts)),
    treasuries: fixture.programAccounts.map((p) => p.pubkey),
    signatures: new Map(),
    calls: [],
    fail: null,
    behind: 0,
  };
  // Graduated markets' DAMM v2 pools (not in the capture, which holds card accounts only): the 1 s poll reads them.
  for (const m of fixture.golden.markets) {
    const damm = fixture.golden.treasuries[m.pool].dammPool;
    if (damm && !chain.accounts.has(damm))
      chain.accounts.set(damm, { owner: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", lamports: 1, executable: false, data: [Buffer.alloc(16).toString("base64"), "base64"] });
  }
  const account = (key) => {
    if (!chain.accounts.has(key)) throw Error(`asked for ${key}, which the fixture does not hold`);
    return toInfo(chain.accounts.get(key));
  };
  const checkSlot = (config) => {
    if (chain.fail) throw Error(chain.fail);
    if (config?.minContextSlot && chain.slot < config.minContextSlot) {
      chain.behind++;
      throw Object.assign(Error("Minimum context slot has not been reached"), { code: -32016 });
    }
  };
  chain.conn = {
    async getProgramAccounts(program, config) {
      chain.calls.push({ method: "getProgramAccounts", config });
      checkSlot(config);
      const value = chain.treasuries.map((pubkey) => ({ pubkey: new PublicKey(pubkey), account: account(pubkey) }));
      return config?.withContext ? { context: { slot: chain.slot }, value } : value;
    },
    async getMultipleAccountsInfoAndContext(keys, config) {
      chain.calls.push({ method: "getMultipleAccounts", keys: keys.map((k) => k.toBase58()), config });
      checkSlot(typeof config === "object" ? config : undefined);
      return { context: { slot: chain.slot }, value: keys.map((k) => account(k.toBase58())) };
    },
    async getMultipleAccountsInfo(keys, config) {
      chain.calls.push({ method: "getMultipleAccountsInfo", keys: keys.map((k) => k.toBase58()), config });
      checkSlot(config);
      return keys.map((k) => {
        const a = account(k.toBase58());
        if (!a || !config?.dataSlice) return a;
        const { offset, length } = config.dataSlice;
        return { ...a, data: a.data.subarray(offset, offset + length) };
      });
    },
    async getSignaturesForAddress(address, { limit = 1000 } = {}) {
      chain.calls.push({ method: "getSignaturesForAddress", address: address.toBase58() });
      if (chain.fail) throw Error(chain.fail);
      return (chain.signatures.get(address.toBase58()) ?? []).slice(0, limit);
    },
  };
  /** Replaces an account's bytes with `edit(buffer)`'s result. */
  chain.edit = (key, edit) => {
    const a = chain.accounts.get(key);
    const data = Buffer.from(a.data[0], "base64");
    edit(data);
    chain.accounts.set(key, { ...a, data: [data.toString("base64"), "base64"] });
  };
  /** A transaction landing on `address` (newest first). */
  chain.land = (address, signature, landedSlot = chain.slot) =>
    chain.signatures.set(address, [{ signature, slot: landedSlot, err: null, blockTime: 1_790_000_000 }, ...(chain.signatures.get(address) ?? [])]);
  return chain;
}

/** The market accounts reader over a fake RPC. */
export const readerOver = (chain, extra = {}) =>
  marketAccountsReader({
    conn: chain.conn,
    programId: PROGRAM,
    discriminator: DISCRIMINATOR,
    quoteMints: QUOTE_MINTS,
    now: () => 1_000,
    sleep: async () => {},
    log: () => {},
    ...extra,
  });

// Pool account fields (lib/treasury/dbc.json poolState, after the 8-byte discriminator).
export const QUOTE_RESERVE = 240,
  SQRT_PRICE = 280,
  IS_MIGRATED = 305;
/** A pool as after a buy: more quote in the curve, a higher price. */
export const bought = (quote = 10_000_000n) => (d) => {
  d.writeBigUInt64LE(d.readBigUInt64LE(QUOTE_RESERVE) + quote, QUOTE_RESERVE);
  const lo = d.readBigUInt64LE(SQRT_PRICE),
    hi = d.readBigUInt64LE(SQRT_PRICE + 8);
  const price = ((hi << 64n) | lo) + ((hi << 64n) | lo) / 50n;
  d.writeBigUInt64LE(price & ((1n << 64n) - 1n), SQRT_PRICE);
  d.writeBigUInt64LE(price >> 64n, SQRT_PRICE + 8);
};
/** A token account's amount (SPL layout: mint, owner, amount). */
export const tokenAmount = (amount) => (d) => d.writeBigUInt64LE(amount, 64);

/** The app's decoder (lib/treasury/snapshot-decode.ts), as the indexer loads it. */
export async function appDecode() {
  return (await import("../../lib/treasury/snapshot-decode.ts")).snapshotFromAccounts;
}

/** A manual clock with timers, for throttles and polls. */
export function manualClock(start = 1_000_000) {
  let t = start;
  let timers = [];
  const clock = {
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { at: t + Math.max(0, ms), fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timers = timers.filter((x) => x !== timer);
    },
    every: (fn, ms) => {
      const timer = { at: t + ms, fn, every: ms };
      timers.push(timer);
      return timer;
    },
    stopEvery: (timer) => clock.clearTimer(timer),
    /** Moves the clock on, running each timer that falls due, in order. */
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = due.at;
        if (due.every) due.at += due.every;
        else timers = timers.filter((x) => x !== due);
        due.fn();
      }
      t = end;
    },
    pending: () => timers.length,
  };
  return clock;
}
