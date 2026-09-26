// Live push: keeps the live market store (modules/market-store.mjs) current
// within about a second of the chain, and wakes the trade sync for a market as
// soon as its pool changes, so open pages (modules/stream.mjs) see new
// markets, curve moves, trades and 24h stats without reloading.
//
// The guaranteed path is a poll, once a second, with a timeout on every call:
//
// - getSignaturesForAddress(treasury program, 5): a new Sonata transaction
//   that succeeded (a market's registration, which is when a market becomes
//   listable, or a fee claim, distribution or redemption) asks the reader
//   for markets registered since its last read (readNew: one call when there
//   are none, three when there is one), at no older slot than that
//   transaction's, at most every TRIGGER_GAP_MS. Claims and the like change
//   card totals with the next 10 s read.
// - getMultipleAccounts of up to 100 pools: each listed market's DBC pool (its
//   curve: price, market cap, progress, graduation), or its DAMM v2 pool once
//   graduated (trades only). A change is decoded and pushed at once, and wakes
//   that market's trade sync, for the venue that changed.
//
// A poll that hits a rate limit or a timeout waits twice as long before the
// next one (up to 8 s), and a second again once one works. When the pool read
// has failed FALLBACK_AFTER_FAILURES times in a row and a fallback RPC is
// configured, the pools are read through it instead, at most every
// FALLBACK_POLL_EVERY_MS and within its daily budget, so curves keep moving
// (about every 5 s) while public Devnet refuses the server.
//
// Websocket subscriptions are not used in this version: public Devnet closes
// a socket at its 251st subscription and its programSubscribe missed about one
// change in six in testing, so they could only ever speed this poll up, and
// the poll already meets the 1–2 s target.
//
// The full read every 10 s (modules/market-accounts.mjs) stays the baseline:
// it covers treasuries, custody, metadata and markets beyond the poll's 100.
// A market whose decode starts failing is read again before any error is
// pushed (the store's suspects), and confirmed at the latest by the next full
// read. After a restart the sync loop catches every market up; live push wakes
// a market's trade sync only for changes it sees after its first full read.
import { PublicKey } from "@solana/web3.js";
import { accountBatches } from "../../lib/treasury/account-batches.mjs";
import { behindSlot, SLOT_RETRIES, SLOT_RETRY_MS } from "./market-accounts.mjs";

export const POLL_MS = 1_000;
export const MAX_POLL_BACKOFF_MS = 8_000;
export const MAX_POLL_KEYS = 100;
/** Reads of new registrations, triggered by new Sonata transactions, at most this often. */
export const TRIGGER_GAP_MS = 3_000;
export const STATS_EVERY_MS = 60_000;
export const STATS_DEBOUNCE_MS = 250;
export const PROFILE_RETRY_MS = 5 * 60_000;
export const PROFILE_CONCURRENCY = 4;
/** Trade syncs woken by pool changes that run at once, and start per second; more wait their turn. */
export const SYNC_CONCURRENCY = 4;
export const SYNC_STARTS_PER_SECOND = 1;
/** Failed pool reads in a row before the fallback RPC reads the pools, and how often it may. */
export const FALLBACK_AFTER_FAILURES = 3;
export const FALLBACK_POLL_EVERY_MS = 5_000;
/** Errors that mean "ask less often": rate limits, timeouts, dropped connections, busy gateways. */
export const BACK_OFF = /429|Too Many|timeout|timed out|aborted|fetch failed|ECONNRESET|socket hang up|\b50[234]\b/i;

const errorText = (e) => String(e?.message ?? e).slice(0, 300);
const toAccount = (a, slot) =>
  a && { owner: a.owner.toBase58(), lamports: a.lamports, executable: a.executable, data: Buffer.from(a.data).toString("base64"), slot };
// p50 and p95 of the last 200 samples.
function samples() {
  const xs = [];
  return {
    add: (v) => {
      xs.push(v);
      if (xs.length > 200) xs.shift();
    },
    summary: () => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      return { n: s.length, p50: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] };
    },
  };
}

/**
 * At most `limit` calls a day (a fixed 24 h window from the first): take()
 * says whether one more may be made, and counts it.
 */
export function dailyBudget(limit, now = Date.now) {
  let start = -Infinity,
    used = 0;
  return {
    take() {
      if (now() - start >= 86_400_000) {
        start = now();
        used = 0;
      }
      if (used >= limit) return false;
      used++;
      return true;
    },
    health: () => ({ limit, used }),
  };
}

/**
 * `store`: the live market store; `reader`: the market accounts reader
 * (readNew() reads markets registered since its last read; request() starts
 * an immediate full read, whose result reaches onRead); `conn`: a web3.js
 * Connection with a short per-call timeout for the poll, and `readConn` one
 * for its other reads (new registrations, re-reads); `fallback` (optional):
 * one to a fallback RPC, used within `fallbackBudget` (dailyBudget) when
 * `conn` keeps failing; `programId`: the treasury program. `fetchProfile(uri)`
 * returns a token profile body (lib/server/token-meta.ts). The database side
 * (trade sync, pools rows, stats) is attached once migrated (attach()).
 */
export function livePush({
  store,
  reader,
  conn,
  readConn = conn,
  fallback = null,
  fallbackBudget = null,
  programId,
  fetchProfile = null,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  every = setInterval,
  stopEvery = clearInterval,
  log = (...a) => console.error(...a),
  pollMs = POLL_MS,
  maxPollKeys = MAX_POLL_KEYS,
  statsEveryMs = STATS_EVERY_MS,
  triggerGapMs = TRIGGER_GAP_MS,
}) {
  const program = new PublicKey(programId);
  let db = null,
    running = false,
    // The newest treasury program transaction seen, once the first poll has looked (`baseline`).
    baseline = false,
    lastSig = null,
    lastSigSlot = 0,
    pendingSuspects = new Set(),
    statsTimer = null,
    loop = null,
    lastError = null,
    lastPollAt = null,
    pollDelay = pollMs,
    poolFailures = 0,
    fallbackPollAt = -Infinity;
  const damm = new Map();
  // Trade syncs: running (pool -> { again, venues }), waiting pools, and the venues each was woken for (null: all).
  const syncing = new Map(),
    waiting = [],
    wokenFor = new Map();
  let active = 0,
    syncTokens = SYNC_STARTS_PER_SECOND,
    tokensAt = now(),
    pumpTimer = null;
  // Reads of new registrations: the slot the next must reach, when the last started, whether one runs.
  let triggerSlot = 0,
    triggerTimer = null,
    triggerAt = -Infinity,
    triggering = false,
    triggeredAt = null;
  const statsDue = new Map();
  // Stats queries in the order they started: each pool's row comes from the latest-started query that answered.
  let statsSeq = 0,
    statsQuery = null;
  const rowFrom = new Map();
  const profileState = new Map(),
    profileQueue = [];
  let profilesReading = 0;
  const timing = { poll: samples(), triggeredRead: samples() };
  const counts = {
    polls: 0,
    pollErrors: 0,
    fallbackPolls: 0,
    triggers: 0,
    newReads: 0,
    poolChanges: 0,
    syncs: 0,
    syncErrors: 0,
    rereads: 0,
    trades: 0,
  };

  // ---- Decoding and what follows it --------------------------------------------

  function apply(treasuries, confirm = new Set()) {
    if (!treasuries.length) return;
    // Markets the first full read adds are caught up by the sync loop, not woken here.
    const wasReady = store.ready;
    const { events, suspects } = store.decode(treasuries, { confirm });
    for (const ev of events) {
      if (ev.kind === "added") {
        ensureProfile(ev.entry.market.uri);
        // Its trades are read once its pools row exists (a sync that ran first would find none).
        if (db)
          void db.insertPool(ev.pool, ev.treasury).then(
            () => wasReady && wake(ev.pool, "dbc"),
            (e) => log("live: pools row failed:", errorText(e)),
          );
      } else if (ev.kind === "updated" && ev.entry.data?.migrated && ev.prev?.data && !ev.prev.data.migrated && db) {
        // Graduated: record its DAMM v2 pool now, so its trades are read from there.
        void db
          .recordGraduation(ev.pool)
          .catch((e) => log("live: graduation record failed:", errorText(e)))
          .finally(() => wake(ev.pool, null));
      }
    }
    if (suspects.length) {
      for (const t of suspects) pendingSuspects.add(t);
      void reread(suspects);
    }
  }

  // A fresh read of suspect markets' accounts (no older than anything seen of
  // them), each market's accounts in one call (one slot), then their decode, confirmed.
  async function reread(treasuries) {
    counts.rereads++;
    const groups = treasuries.map((t) => store.groupOf(t)).filter(Boolean);
    const minContextSlot = Math.max(0, ...groups.map((g) => g.slot));
    try {
      const entries = [];
      for (const batch of accountBatches(groups.map((g) => g.keys))) {
        let answer;
        for (let attempt = 0; ; attempt++) {
          try {
            answer = await readConn.getMultipleAccountsInfoAndContext(
              batch.map((k) => new PublicKey(k)),
              { commitment: "confirmed", ...(minContextSlot ? { minContextSlot } : {}) },
            );
            break;
          } catch (e) {
            if (!behindSlot(e) || attempt >= SLOT_RETRIES) throw e;
            await sleep(SLOT_RETRY_MS);
          }
        }
        batch.forEach((k, j) => entries.push([k, toAccount(answer.value[j], answer.context.slot)]));
      }
      const more = store.patch(entries);
      const confirm = new Set(treasuries.filter((t) => pendingSuspects.delete(t)));
      apply([...new Set([...confirm, ...more])], confirm);
    } catch (e) {
      // Confirmed by the next full read instead.
      log("live: re-read failed:", errorText(e));
    }
  }

  /** A full read (the reader's onRead): merged, decoded, pushed; suspects from before are confirmed by it. */
  function onRead(read) {
    const todo = store.mergeRead(read);
    const confirm = pendingSuspects;
    pendingSuspects = new Set();
    apply([...new Set([...todo, ...confirm])], confirm);
    for (const e of store.entries()) ensureProfile(e.market.uri);
  }

  // ---- New registrations -----------------------------------------------------

  // A read of new registrations at no older slot than `slot`: now, or once TRIGGER_GAP_MS has passed since the last.
  function trigger(slot) {
    triggerSlot = Math.max(triggerSlot, slot);
    triggeredAt ??= now();
    if (triggering || triggerTimer !== null) return;
    const wait = triggerAt + triggerGapMs - now();
    if (wait > 0)
      triggerTimer = setTimer(() => {
        triggerTimer = null;
        void readNew();
      }, wait);
    else void readNew();
  }
  async function readNew() {
    triggering = true;
    triggerAt = now();
    const slot = triggerSlot;
    triggerSlot = 0;
    const since = triggeredAt;
    triggeredAt = null;
    try {
      counts.newReads++;
      const part = await reader.readNew(slot, { on: readConn, budget: fallbackBudget });
      // Before the reader's first complete read: a full read instead.
      if (!part) await reader.request(slot);
      else if (part.treasuries.length) apply(store.mergeNew(part));
      if (since !== null) timing.triggeredRead.add(now() - since);
    } catch (e) {
      // The next full read (10 s) lists it instead.
      log("live: new market read failed:", errorText(e));
    } finally {
      triggering = false;
      if (triggerSlot) trigger(triggerSlot);
    }
  }

  // ---- The 1 s poll -------------------------------------------------------------

  async function checkSignatures() {
    const list = await conn.getSignaturesForAddress(program, { limit: 5 }, "confirmed");
    const newest = list[0];
    // The first poll only notes where things stand (the first full read covers what came before).
    if (!baseline) {
      baseline = true;
      lastSig = newest?.signature ?? null;
      lastSigSlot = newest?.slot ?? 0;
      return;
    }
    // Nothing, or a node that answers with an older view: no news.
    if (!newest || newest.slot < lastSigSlot || newest.signature === lastSig) return;
    const fresh = [];
    for (const s of list) {
      if (s.signature === lastSig) break;
      fresh.push(s);
    }
    lastSig = newest.signature;
    lastSigSlot = newest.slot;
    // A failed transaction changed nothing.
    const landed = fresh.filter((s) => !s.err);
    if (!landed.length) return;
    counts.triggers++;
    trigger(Math.max(...landed.map((s) => Number(s.slot) || 0)));
  }

  // The poll's pools, through `conn`, or through the fallback once `conn` keeps failing (paced, within its budget).
  async function poolAccounts(keys) {
    const pubkeys = keys.map((k) => new PublicKey(k.key));
    try {
      const answer = await conn.getMultipleAccountsInfoAndContext(pubkeys, "confirmed");
      poolFailures = 0;
      return answer;
    } catch (e) {
      poolFailures++;
      if (!fallback || poolFailures < FALLBACK_AFTER_FAILURES || now() - fallbackPollAt < FALLBACK_POLL_EVERY_MS) throw e;
      if (fallbackBudget && !fallbackBudget.take()) throw e;
      fallbackPollAt = now();
      counts.fallbackPolls++;
      try {
        return await fallback.getMultipleAccountsInfoAndContext(pubkeys, "confirmed");
      } catch (f) {
        throw Error(`${errorText(e)}; fallback: ${errorText(f)}`);
      }
    }
  }

  async function readPools() {
    const keys = store.pollKeys(maxPollKeys);
    if (!keys.length) return;
    const { context, value } = await poolAccounts(keys);
    const patches = [],
      woken = new Map();
    keys.forEach((k, i) => {
      const account = toAccount(value[i], context.slot);
      if (k.venue === "dbc") patches.push([k.key, account]);
      else if (account) {
        const before = damm.get(k.key);
        if (before !== undefined && before !== account.data) woken.set(k.pool, "damm");
        damm.set(k.key, account.data);
      }
    });
    // Only pools were read, so each market to decode is one whose pool changed.
    const todo = store.patch(patches);
    for (const t of todo) {
      const pool = store.poolOf(t);
      if (pool) woken.set(pool, "dbc");
    }
    counts.poolChanges += woken.size;
    apply(todo);
    for (const [pool, venue] of woken) wake(pool, venue);
  }

  /** One poll. Resolves to whether the next should wait longer (a rate limit or a timeout). */
  async function pollOnce() {
    const started = now();
    const [sigs, pools] = await Promise.allSettled([checkSignatures(), readPools()]);
    counts.polls++;
    lastPollAt = now();
    timing.poll.add(lastPollAt - started);
    const failed = [sigs, pools].filter((r) => r.status === "rejected").map((r) => errorText(r.reason));
    if (failed.length) {
      counts.pollErrors++;
      if (failed[0] !== lastError) log("live poll failed:", failed.join("; "));
      lastError = failed[0];
    } else lastError = null;
    return failed.some((f) => BACK_OFF.test(f));
  }

  // ---- Trades, stats and profiles ------------------------------------------------

  // Reads a market's new trades soon: `venue` "dbc" (its curve), "damm" (its graduated pool) or null (both).
  function wake(pool, venue = null) {
    if (!db) return;
    const before = wokenFor.has(pool) ? wokenFor.get(pool) : undefined;
    // Venues to read: all if any wake asked for all.
    wokenFor.set(pool, before === null || venue === null ? null : new Set([...(before ?? []), venue]));
    const s = syncing.get(pool);
    if (s) {
      s.again = true;
      return;
    }
    if (!waiting.includes(pool)) waiting.push(pool);
    pumpSyncs();
  }
  // Starts waiting syncs while fewer than SYNC_CONCURRENCY run and this second's starts allow.
  function pumpSyncs() {
    const t = now();
    syncTokens = Math.min(SYNC_STARTS_PER_SECOND, syncTokens + ((t - tokensAt) / 1000) * SYNC_STARTS_PER_SECOND);
    tokensAt = t;
    while (waiting.length && active < SYNC_CONCURRENCY && syncTokens >= 1) {
      const pool = waiting.shift();
      if (syncing.has(pool)) continue;
      syncTokens--;
      void runSync(pool);
    }
    if (waiting.length && active < SYNC_CONCURRENCY && pumpTimer === null)
      pumpTimer = setTimer(() => {
        pumpTimer = null;
        pumpSyncs();
      }, Math.ceil(((1 - syncTokens) / SYNC_STARTS_PER_SECOND) * 1000));
  }
  async function runSync(pool) {
    const s = { again: false };
    const venues = wokenFor.has(pool) ? wokenFor.get(pool) : null;
    wokenFor.delete(pool);
    syncing.set(pool, s);
    active++;
    counts.syncs++;
    try {
      await db.syncPool(pool, venues);
    } catch (e) {
      counts.syncErrors++;
      log("live: trade sync failed:", pool, errorText(e));
    } finally {
      active--;
      syncing.delete(pool);
      if (s.again) {
        if (!waiting.includes(pool)) waiting.push(pool);
      }
      pumpSyncs();
    }
  }

  // Stats rows from the query that started `id`th: kept unless a later-started query already answered for that pool.
  function takeStats(rows, id, full) {
    const fresh = rows.filter((r) => r?.pool && (rowFrom.get(r.pool) ?? 0) < id);
    for (const r of fresh) rowFrom.set(r.pool, id);
    store.setStats(fresh, { full });
  }
  function statsSoon(pool) {
    if (!db || statsDue.has(pool)) return;
    statsDue.set(
      pool,
      setTimer(() => {
        statsDue.delete(pool);
        const id = ++statsSeq;
        db.statsFor(pool)
          .then((row) => row && takeStats([row], id, false))
          .catch((e) => log("live: stats failed:", errorText(e)));
      }, STATS_DEBOUNCE_MS),
    );
  }
  // Every market's stats, one query at a time (a slow database gets no pile-up).
  function allStats() {
    if (!db || statsQuery) return statsQuery;
    const id = ++statsSeq;
    statsQuery = db
      .allStats()
      .then((rows) => takeStats(rows, id, true))
      .catch((e) => log("live: stats failed:", errorText(e)))
      .finally(() => (statsQuery = null));
    return statsQuery;
  }

  // Token profiles, PROFILE_CONCURRENCY at a time.
  function ensureProfile(uri) {
    if (!uri || !fetchProfile) return;
    const st = profileState.get(uri);
    if (st === "ok" || st === "reading" || st === "queued" || (typeof st === "number" && now() - st < PROFILE_RETRY_MS)) return;
    profileState.set(uri, "queued");
    profileQueue.push(uri);
    pumpProfiles();
  }
  function pumpProfiles() {
    while (profileQueue.length && profilesReading < PROFILE_CONCURRENCY) {
      const uri = profileQueue.shift();
      profileState.set(uri, "reading");
      profilesReading++;
      fetchProfile(uri)
        .then((body) => {
          profileState.set(uri, "ok");
          // What a card shows: the image and the fee model.
          store.setProfile(uri, { ...(body?.image ? { image: body.image } : {}), ...(body?.sonata ? { sonata: body.sonata } : {}) });
        })
        .catch(() => {
          profileState.set(uri, now());
          if (!store.hasProfile(uri)) store.setProfile(uri, null);
        })
        .finally(() => {
          profilesReading--;
          pumpProfiles();
        });
    }
  }

  return {
    onRead,
    /** A trade row the sync just inserted (either path): pushed to its market's pages, and its stats refreshed. */
    onTrade(row) {
      counts.trades++;
      store.publishTrade(row);
      statsSoon(row.pool);
    },
    /**
     * The database side, once migrated: { syncPool(pool, venues), insertPool,
     * recordGraduation, statsFor, allStats }. Nothing is woken for markets
     * already listed: the sync loop catches them up.
     */
    attach(deps) {
      db = deps;
      void allStats();
      statsTimer = every(() => {
        void allStats();
        for (const e of store.entries()) ensureProfile(e.market.uri);
      }, statsEveryMs);
    },
    start() {
      if (running) return;
      running = true;
      loop = (async () => {
        while (running) {
          const started = now();
          const slower = await pollOnce();
          pollDelay = slower ? Math.min(MAX_POLL_BACKOFF_MS, pollDelay * 2) : pollMs;
          await sleep(Math.max(0, pollDelay - (now() - started)));
        }
      })();
    },
    async stop() {
      running = false;
      stopEvery(statsTimer);
      clearTimer(pumpTimer);
      clearTimer(triggerTimer);
      for (const t of statsDue.values()) clearTimer(t);
      await loop;
    },
    pollOnce,
    health: () => ({
      running,
      lastPollAt,
      lastError,
      pollDelayMs: pollDelay,
      ...counts,
      ...(fallbackBudget ? { fallbackBudget: fallbackBudget.health() } : {}),
      pollMs: timing.poll.summary(),
      triggeredReadMs: timing.triggeredRead.summary(),
      syncing: active,
      syncWaiting: waiting.length,
      store: store.health(),
    }),
  };
}
