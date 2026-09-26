// The raw accounts of every Sonata market, read every 10 seconds, for the web
// app's server-rendered market list and market pages (lib/server/market-snapshot.ts),
// served at /api/index/accounts.
//
// This module decides nothing about a market: it lists the treasury program's
// accounts, derives the addresses each market's card reads (pool, config,
// metadata, treasury, base mint, and the treasury's and payout wallet's quote
// accounts, plus the quote mints and the program), and reads them in
// getMultipleAccounts calls of at most 100, never splitting one market's
// accounts across calls. The app decodes and checks everything itself with the
// same code the browser runs (runtime.ts: treasuryEntries, marketsFromAccounts,
// treasuryFromAccounts), looking accounts up by addresses it derives on its
// own: an address derived wrongly here is simply missing there, and that
// market shows an error instead of numbers.
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";

export const MARKET_ACCOUNTS_INTERVAL_MS = 10_000;
export const MAX_KEYS_PER_CALL = 100;
const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/** The keys a treasury account names, from its fixed layout after the 8-byte discriminator. */
export function treasuryFields(data) {
  const d = Buffer.from(data);
  if (d.length < 201) throw Error("treasury account too short");
  const key = (offset) => new PublicKey(d.subarray(offset, offset + 32));
  return { pool: key(8), config: key(40), quoteMint: key(72), baseMint: key(104), payoutOwner: key(168) };
}

/** One market's card accounts, in the order runtime.ts reads them (cardKeys). */
export function marketKeys(treasury, t) {
  return [
    t.pool,
    t.config,
    PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBuffer(), t.baseMint.toBuffer()], METAPLEX)[0],
    treasury,
    t.baseMint,
    getAssociatedTokenAddressSync(t.quoteMint, treasury, true, TOKEN_2022_PROGRAM_ID),
    getAssociatedTokenAddressSync(t.quoteMint, t.payoutOwner, true, TOKEN_2022_PROGRAM_ID),
  ].map((k) => k.toBase58());
}

/**
 * getMultipleAccounts calls of at most MAX_KEYS_PER_CALL keys: the shared keys
 * first, then each group whole. A key is read once, in the first call that
 * needs it (as runtime.ts's accountBatches does).
 */
export function keyBatches(groups, shared = []) {
  const batches = [],
    seen = new Set();
  let current = [];
  const add = (keys) => {
    for (const k of keys)
      if (!seen.has(k)) {
        seen.add(k);
        current.push(k);
      }
  };
  add(shared);
  for (const group of groups) {
    const fresh = [...new Set(group)].filter((k) => !seen.has(k));
    if (current.length && current.length + fresh.length > MAX_KEYS_PER_CALL) {
      batches.push(current);
      current = [];
    }
    add(fresh);
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Reads every market's accounts on `conn`, one read at a time. `current()` is
 * the last complete read ({ v, readAt, slot, ms, calls, treasuries, accounts })
 * or null before the first; a failed read keeps the previous one, so the app
 * decides by `readAt` how old is too old. Accounts are
 * { owner, lamports, executable, data (base64), slot } or null if missing.
 */
export function marketAccountsReader({
  conn,
  programId,
  discriminator,
  quoteMints,
  now = Date.now,
  log = (...a) => console.error(...a),
}) {
  const program = new PublicKey(programId);
  let current = null,
    reading = null,
    failing = false;

  async function read() {
    const started = now();
    const listed = await conn.getProgramAccounts(program, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(discriminator)) } }],
    });
    const treasuries = [],
      groups = [],
      quotes = new Set();
    for (const { pubkey, account } of listed) {
      let t;
      try {
        t = treasuryFields(account.data);
      } catch {
        continue;
      }
      // Only markets on a registered mock stock can be listed; the app checks again.
      if (!quoteMints.has(t.quoteMint.toBase58())) continue;
      treasuries.push(pubkey.toBase58());
      groups.push(marketKeys(pubkey, t));
      quotes.add(t.quoteMint.toBase58());
    }
    const accounts = {};
    let slot = Infinity,
      calls = 1;
    for (const batch of keyBatches(groups, [...quotes, program.toBase58()])) {
      const { context, value } = await conn.getMultipleAccountsInfoAndContext(
        batch.map((k) => new PublicKey(k)),
        "confirmed",
      );
      calls++;
      batch.forEach((k, i) => {
        const a = value[i];
        accounts[k] = a
          ? {
              owner: a.owner.toBase58(),
              lamports: a.lamports,
              executable: a.executable,
              data: Buffer.from(a.data).toString("base64"),
              slot: context.slot,
            }
          : null;
      });
      slot = Math.min(slot, context.slot);
    }
    const readAt = now();
    return {
      v: 1,
      readAt,
      slot: Number.isFinite(slot) ? slot : 0,
      ms: readAt - started,
      calls,
      treasuries,
      accounts,
    };
  }

  /** Starts a read unless one is running; resolves when it ends (never rejects). */
  function tick() {
    reading ??= read()
      .then((snapshot) => {
        if (failing || !current)
          log(`market accounts: ${snapshot.treasuries.length} markets in ${snapshot.ms} ms (${snapshot.calls} calls)`);
        failing = false;
        current = snapshot;
      })
      .catch((e) => {
        if (!failing) log("market accounts read failed:", String(e?.message ?? e).slice(0, 300));
        failing = true;
      })
      .finally(() => {
        reading = null;
      });
    return reading;
  }

  return { tick, read, current: () => current };
}
