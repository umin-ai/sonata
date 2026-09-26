// The raw accounts of every Sonata market, read every 10 seconds, for the web
// app's server-rendered market list and market pages (lib/server/market-snapshot.ts),
// served at /api/index/accounts.
//
// It reads through `conn` (public Devnet, or SOLANA_RPC_URL). When that fails
// twice in a row it also reads through `fallback` (a dedicated provider, e.g.
// GetBlock, whose getMultipleAccounts takes 100 keys), at most every 30 s to
// stay inside a provider's budget, until `conn` answers again. Each switch is
// logged; the answer says which one served it (`source`).
//
// Every read is bounded: at most MAX_MARKETS markets (the newest, by their
// pools' activation time, when more are registered), so its calls, the app's
// pages and the live stream stay bounded however many markets launch. Each
// read asks for state no older than the last one it saw (minContextSlot), so a
// node that lags behind is refused rather than taken for the chain going back.
//
// With live push (modules/live.mjs) each read also goes to `onRead`, and when
// a new Sonata transaction shows up the live module asks for the markets
// registered since the last read (`readNew`): the treasury program's account
// list without data (one call), and only when it names a treasury no read has
// seen, that treasury and its market's accounts (two more). A claim,
// distribution or redemption on a market already read costs that one call;
// its totals change on the cards with the next 10 s read. When `conn` fails,
// `readNew` tries the fallback at once (registrations are rare), within the
// daily budget it is given.
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
import { accountBatches, MAX_ACCOUNTS_PER_CALL } from "../../lib/treasury/account-batches.mjs";

export const MARKET_ACCOUNTS_INTERVAL_MS = 10_000;
export const MAX_KEYS_PER_CALL = MAX_ACCOUNTS_PER_CALL;
/** The most markets one read covers: the newest by launch time when more are registered. */
export const MAX_MARKETS = 200;
/** Where a DBC pool account keeps its activation point (u64, unix seconds for Sonata's configs). */
export const POOL_ACTIVATION_POINT_OFFSET = 296;
/** An RPC node behind the slot a read asks for is asked again this often, this many times. */
export const SLOT_RETRY_MS = 200;
export const SLOT_RETRIES = 5;
/** Whether an RPC error says the node has not reached the requested minContextSlot yet. */
export const behindSlot = (e) => e?.code === -32016 || /minimum context slot/i.test(String(e?.message ?? e));
/** Reads through the fallback happen at most this often. */
export const FALLBACK_EVERY_MS = 30_000;
/** Failed reads through `conn` in a row before the fallback is used. */
export const FAILURES_BEFORE_FALLBACK = 2;
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

/** The keys every card needs once: its quote mint and the treasury program. */
export const sharedKeys = (quoteMint, programId) => [String(quoteMint), String(programId)];

/**
 * getMultipleAccounts calls of at most `max` keys: the shared keys first, then
 * each group whole. The same function the app's readers use
 * (lib/treasury/account-batches.mjs).
 */
export const keyBatches = accountBatches;

/**
 * Reads every market's accounts on `conn` (or `fallback`, see above), one read
 * at a time. `current()` is the last complete read ({ v, readAt, slot, ms,
 * calls, source, treasuries, accounts }) or null before the first, and
 * `currentJson()` the same serialized once per read; a failed read keeps the
 * previous one, so the app decides by `readAt` how old is too old. Accounts
 * are { owner, lamports, executable, data (base64), slot } or null if missing.
 * `onRead(read)` gets every complete read (the live module's store).
 */
export function marketAccountsReader({
  conn,
  fallback = null,
  programId,
  discriminator,
  quoteMints,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (...a) => console.error(...a),
  maxKeysPerCall = MAX_KEYS_PER_CALL,
  fallbackEveryMs = FALLBACK_EVERY_MS,
  maxMarkets = MAX_MARKETS,
  onRead = null,
}) {
  const program = new PublicKey(programId);
  let current = null,
    json = null,
    reading = null,
    again = null,
    failing = false,
    failures = 0,
    onFallback = false,
    fallbackFailing = false,
    fallbackAt = -Infinity,
    // The newest slot a listing was answered at: later reads ask for no older state.
    listedSlot = 0,
    // The registered count last logged as over MAX_MARKETS.
    overCap = 0;
  // Every treasury a read has listed (kept, cut by MAX_MARKETS, or not on a listed stock), so readNew reads only new ones.
  let seen = null;
  // Pools' launch times (activation points), read only when more markets are registered than a read covers.
  const launchTimes = new Map();

  // A call to a node that has not reached `minContextSlot` yet is repeated a few times, 200 ms apart.
  async function atSlot(call) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (e) {
        if (!behindSlot(e) || attempt >= SLOT_RETRIES) throw e;
        await sleep(SLOT_RETRY_MS);
      }
    }
  }

  // The newest `maxMarkets` of the listed markets by launch time; activation points not known yet are read (8 bytes each).
  async function newest(on, found, minContextSlot) {
    const unknown = found.filter((f) => !launchTimes.has(f.t.pool.toBase58()));
    let calls = 0;
    for (let i = 0; i < unknown.length; i += maxKeysPerCall) {
      const batch = unknown.slice(i, i + maxKeysPerCall);
      const infos = await atSlot(() =>
        on.getMultipleAccountsInfo(
          batch.map((f) => f.t.pool),
          { commitment: "confirmed", dataSlice: { offset: POOL_ACTIVATION_POINT_OFFSET, length: 8 }, ...(minContextSlot ? { minContextSlot } : {}) },
        ),
      );
      calls++;
      batch.forEach((f, j) => {
        const d = infos[j]?.data;
        launchTimes.set(f.t.pool.toBase58(), d && d.length >= 8 ? Number(Buffer.from(d).readBigUInt64LE(0)) : 0);
      });
    }
    if (launchTimes.size > 20 * maxMarkets) for (const k of [...launchTimes.keys()].slice(0, launchTimes.size - 10 * maxMarkets)) launchTimes.delete(k);
    const at = (f) => launchTimes.get(f.t.pool.toBase58()) ?? 0;
    const kept = new Set([...found].sort((a, b) => at(b) - at(a) || (a.key < b.key ? -1 : 1)).slice(0, maxMarkets));
    return { kept: found.filter((f) => kept.has(f)), calls };
  }

  async function read(on = conn, { minContextSlot = 0 } = {}) {
    const started = now();
    // No older state than the last listing, nor than the caller needs (a transaction it saw land).
    const floor = Math.max(minContextSlot, listedSlot);
    const answer = await atSlot(() =>
      on.getProgramAccounts(program, {
        commitment: "confirmed",
        filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(discriminator)) } }],
        withContext: true,
        ...(floor ? { minContextSlot: floor } : {}),
      }),
    );
    const listed = Array.isArray(answer) ? answer : answer.value;
    const programSlot = Array.isArray(answer) ? 0 : Number(answer.context?.slot) || 0;
    const listedKeys = listed.map(({ pubkey }) => pubkey.toBase58());
    let found = [];
    for (const { pubkey, account } of listed) {
      let t;
      try {
        t = treasuryFields(account.data);
      } catch {
        continue;
      }
      // Only markets on a registered mock stock can be listed; the app checks again.
      if (!quoteMints.has(t.quoteMint.toBase58())) continue;
      found.push({ key: pubkey.toBase58(), pubkey, t });
    }
    const registered = found.length;
    let calls = 1;
    if (found.length > maxMarkets) {
      const cut = await newest(on, found, floor);
      found = cut.kept;
      calls += cut.calls;
    }
    const treasuries = found.map((f) => f.key),
      groups = found.map((f) => marketKeys(f.pubkey, f.t)),
      quotes = new Set(found.map((f) => f.t.quoteMint.toBase58()));
    const accounts = {};
    let slot = Infinity;
    for (const batch of accountBatches(groups, [...quotes, program.toBase58()], maxKeysPerCall)) {
      const { context, value } = await atSlot(() =>
        on.getMultipleAccountsInfoAndContext(
          batch.map((k) => new PublicKey(k)),
          floor ? { commitment: "confirmed", minContextSlot: floor } : "confirmed",
        ),
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
    if (programSlot > listedSlot) listedSlot = programSlot;
    seen = new Set(listedKeys);
    const readAt = now();
    return {
      v: 1,
      readAt,
      slot: Number.isFinite(slot) ? slot : 0,
      ms: readAt - started,
      calls,
      treasuries,
      accounts,
      // Registered markets on a listed stock, before the MAX_MARKETS cut.
      registered,
    };
  }

  const keep = (snapshot, source) => {
    current = { ...snapshot, source };
    json = null;
    if (snapshot.registered > maxMarkets && snapshot.registered !== overCap)
      log(`market accounts: ${snapshot.registered} markets registered; reading the newest ${maxMarkets}`);
    overCap = snapshot.registered;
    if (onRead)
      try {
        onRead(current);
      } catch (e) {
        log("market accounts: live update failed:", message(e));
      }
  };
  const message = (e) => String(e?.message ?? e).slice(0, 300);

  // One read through `conn`, and through the fallback when `conn` keeps failing and it is due.
  async function once(minContextSlot = 0) {
    try {
      const snapshot = await read(conn, { minContextSlot });
      if (failing || !current)
        log(`market accounts: ${snapshot.treasuries.length} markets in ${snapshot.ms} ms (${snapshot.calls} calls)`);
      if (onFallback) log("market accounts: the primary RPC answers again; the fallback is no longer used");
      failing = false;
      failures = 0;
      onFallback = false;
      keep(snapshot, "primary");
      return;
    } catch (e) {
      if (!failing) log("market accounts read failed:", message(e));
      failing = true;
      failures++;
    }
    if (!fallback || failures < FAILURES_BEFORE_FALLBACK || now() - fallbackAt < fallbackEveryMs) return;
    fallbackAt = now();
    try {
      const snapshot = await read(fallback, { minContextSlot });
      if (!onFallback) log(`market accounts: reading through the fallback RPC (${snapshot.treasuries.length} markets in ${snapshot.ms} ms)`);
      onFallback = true;
      fallbackFailing = false;
      keep(snapshot, "fallback");
    } catch (e) {
      if (!fallbackFailing) log("market accounts: the fallback RPC failed too:", message(e));
      fallbackFailing = true;
    }
  }

  /**
   * The markets registered since the last complete read, at no older slot
   * than `minContextSlot`: { readAt, slot, calls, source, treasuries (only the
   * new ones on a listed stock), accounts (theirs, as a full read has them) }.
   * Null before the first complete read (the caller asks for a full read
   * instead). Throws when neither `on` (default `conn`) nor, within `budget`,
   * the fallback answers.
   */
  async function readNew(minContextSlot = 0, { on = conn, budget = null } = {}) {
    if (!seen) return null;
    try {
      return { ...(await newOn(on, minContextSlot)), source: "primary" };
    } catch (e) {
      if (!fallback || (budget && !budget.take())) throw e;
      return { ...(await newOn(fallback, minContextSlot)), source: "fallback" };
    }
  }
  async function newOn(on, minContextSlot) {
    const started = now();
    const floor = Math.max(minContextSlot, listedSlot);
    const answer = await atSlot(() =>
      on.getProgramAccounts(program, {
        commitment: "confirmed",
        filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(discriminator)) } }],
        dataSlice: { offset: 0, length: 0 },
        withContext: true,
        ...(floor ? { minContextSlot: floor } : {}),
      }),
    );
    const listed = Array.isArray(answer) ? answer : answer.value;
    const programSlot = Array.isArray(answer) ? 0 : Number(answer.context?.slot) || 0;
    const fresh = listed.map(({ pubkey }) => pubkey.toBase58()).filter((k) => !seen.has(k));
    let calls = 1,
      slot = Infinity;
    const accounts = {},
      treasuries = [];
    if (fresh.length) {
      const at = Math.max(floor, programSlot);
      const read = async (keys) => {
        const out = [];
        for (let i = 0; i < keys.length; i += maxKeysPerCall) {
          const batch = keys.slice(i, i + maxKeysPerCall);
          const { context, value } = await atSlot(() =>
            on.getMultipleAccountsInfoAndContext(
              batch.map((k) => new PublicKey(k)),
              at ? { commitment: "confirmed", minContextSlot: at } : "confirmed",
            ),
          );
          calls++;
          slot = Math.min(slot, context.slot);
          batch.forEach((k, j) => out.push([k, value[j], context.slot]));
        }
        return out;
      };
      const groups = [],
        quotes = new Set();
      for (const [key, a] of await read(fresh)) {
        seen.add(key);
        let t;
        try {
          t = treasuryFields(a?.data ?? Buffer.alloc(0));
        } catch {
          continue;
        }
        if (!quoteMints.has(t.quoteMint.toBase58())) continue;
        treasuries.push(key);
        groups.push(marketKeys(new PublicKey(key), t));
        quotes.add(t.quoteMint.toBase58());
      }
      if (groups.length)
        for (const batch of accountBatches(groups, [...quotes, program.toBase58()], maxKeysPerCall))
          for (const [k, a, at2] of await read(batch))
            accounts[k] = a
              ? { owner: a.owner.toBase58(), lamports: a.lamports, executable: a.executable, data: Buffer.from(a.data).toString("base64"), slot: at2 }
              : null;
    }
    if (programSlot > listedSlot) listedSlot = programSlot;
    const readAt = now();
    return { v: 1, readAt, slot: Number.isFinite(slot) ? slot : programSlot, ms: readAt - started, calls, treasuries, accounts };
  }

  /** Starts a read unless one is running; resolves when it ends (never rejects). */
  function tick({ minContextSlot = 0 } = {}) {
    reading ??= once(minContextSlot).finally(() => {
      reading = null;
    });
    return reading;
  }

  /**
   * A read that starts now, or right after the one running (which may have
   * listed before whatever the caller saw land), no older than
   * `minContextSlot`. Requests made during one read share the next one.
   * Resolves when it ends (never rejects).
   */
  function request(minContextSlot = 0) {
    if (!reading) return tick({ minContextSlot });
    if (!again) {
      const next = { minContextSlot: 0, promise: null };
      next.promise = reading.then(() => {
        again = null;
        return tick({ minContextSlot: next.minContextSlot });
      });
      again = next;
    }
    again.minContextSlot = Math.max(again.minContextSlot, minContextSlot);
    return again.promise;
  }

  return {
    tick,
    request,
    readNew,
    read,
    current: () => current,
    /** The current read as JSON, serialized once per read (the API sends it as it is). */
    currentJson: () => (current ? (json ??= JSON.stringify(current)) : null),
  };
}
