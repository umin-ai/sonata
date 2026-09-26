// Live push: keeps the live market store (modules/market-store.mjs) current
// within about a second of the chain, and wakes the trade sync for a market as
// soon as its pool changes, so open pages (modules/stream.mjs) see new
// markets, curve moves, trades and 24h stats without reloading.
//
// The guaranteed path is a poll, once a second, with a timeout on every call:
//
// - getSignaturesForAddress(treasury program, 5): a new Sonata transaction (a
//   market's registration, which is when a market becomes listable, or a
//   fee claim, distribution or redemption) triggers an immediate full read of
//   every market's accounts at no older slot than that transaction's.
// - getMultipleAccounts of up to 100 pools: each listed market's DBC pool (its
//   curve: price, market cap, progress, graduation), or its DAMM v2 pool once
//   graduated (trades only). A change is decoded and pushed at once, and wakes
//   that market's trade sync.
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
// read.
import { PublicKey } from "@solana/web3.js";
import { behindSlot, SLOT_RETRIES, SLOT_RETRY_MS } from "./market-accounts.mjs";

export const POLL_MS = 1_000;
export const MAX_POLL_KEYS = 100;
export const STATS_EVERY_MS = 60_000;
export const STATS_DEBOUNCE_MS = 250;
export const PROFILE_RETRY_MS = 5 * 60_000;
/** Trade syncs woken by pool changes that run at once; more wait their turn. */
export const SYNC_CONCURRENCY = 4;

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
 * `store`: the live market store; `reader`: the market accounts reader
 * (request() starts an immediate full read, whose result reaches onRead);
 * `conn`: a web3.js Connection with a short per-call timeout for the poll;
 * `programId`: the treasury program. `fetchProfile(uri)` returns a token
 * profile body (lib/server/token-meta.ts). The database side (trade sync,
 * pools rows, stats) is attached once migrated (attach()).
 */
export function livePush({
  store,
  reader,
  conn,
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
    lastPollAt = null;
  const damm = new Map();
  const syncing = new Map(),
    waiting = [];
  let active = 0;
  const statsDue = new Map();
  const profileState = new Map();
  const timing = { poll: samples(), triggeredRead: samples() };
  const counts = { polls: 0, pollErrors: 0, triggers: 0, poolChanges: 0, syncs: 0, syncErrors: 0, rereads: 0, trades: 0 };
  let triggeredAt = null;

  // ---- Decoding and what follows it --------------------------------------------

  function apply(treasuries, confirm = new Set()) {
    if (!treasuries.length) return;
    const { events, suspects } = store.decode(treasuries, { confirm });
    for (const ev of events) {
      if (ev.kind === "added") {
        ensureProfile(ev.entry.market.uri);
        if (db) void db.insertPool(ev.pool, ev.treasury).catch((e) => log("live: pools row failed:", errorText(e)));
        wake(ev.pool);
      } else if (ev.kind === "updated" && ev.entry.data?.migrated && ev.prev?.data && !ev.prev.data.migrated && db) {
        // Graduated: record its DAMM v2 pool now, so its trades are read from there.
        void db
          .recordGraduation(ev.pool)
          .catch((e) => log("live: graduation record failed:", errorText(e)))
          .finally(() => wake(ev.pool));
      }
    }
    if (suspects.length) {
      for (const t of suspects) pendingSuspects.add(t);
      void reread(suspects);
    }
  }

  // A fresh read of suspect markets' accounts (no older than anything seen of them), then their decode, confirmed.
  async function reread(treasuries) {
    counts.rereads++;
    const groups = treasuries.map((t) => store.groupOf(t)).filter(Boolean);
    const keys = [...new Set(groups.flatMap((g) => g.keys))];
    const minContextSlot = Math.max(0, ...groups.map((g) => g.slot));
    try {
      const entries = [];
      for (let i = 0; i < keys.length; i += 100) {
        const batch = keys.slice(i, i + 100);
        let answer;
        for (let attempt = 0; ; attempt++) {
          try {
            answer = await conn.getMultipleAccountsInfoAndContext(
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
    if (triggeredAt !== null) {
      timing.triggeredRead.add(now() - triggeredAt);
      triggeredAt = null;
    }
    for (const e of store.entries()) ensureProfile(e.market.uri);
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
    counts.triggers++;
    triggeredAt ??= now();
    void reader.request(Math.max(...fresh.map((s) => Number(s.slot) || 0)));
  }

  async function readPools() {
    const keys = store.pollKeys(maxPollKeys);
    if (!keys.length) return;
    const { context, value } = await conn.getMultipleAccountsInfoAndContext(
      keys.map((k) => new PublicKey(k.key)),
      "confirmed",
    );
    const patches = [],
      woken = new Set();
    keys.forEach((k, i) => {
      const account = toAccount(value[i], context.slot);
      if (k.venue === "dbc") patches.push([k.key, account]);
      else if (account) {
        const before = damm.get(k.key);
        if (before !== undefined && before !== account.data) woken.add(k.pool);
        damm.set(k.key, account.data);
      }
    });
    // Only pools were read, so each market to decode is one whose pool changed.
    const todo = store.patch(patches);
    for (const t of todo) {
      const pool = store.poolOf(t);
      if (pool) woken.add(pool);
    }
    counts.poolChanges += woken.size;
    apply(todo);
    for (const pool of woken) wake(pool);
  }

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
  }

  // ---- Trades, stats and profiles ------------------------------------------------

  function wake(pool) {
    if (!db) return;
    const s = syncing.get(pool);
    if (s) {
      s.again = true;
      return;
    }
    if (active >= SYNC_CONCURRENCY) {
      if (!waiting.includes(pool)) waiting.push(pool);
      return;
    }
    void runSync(pool);
  }
  async function runSync(pool) {
    const s = { again: false };
    syncing.set(pool, s);
    active++;
    counts.syncs++;
    try {
      await db.syncPool(pool);
    } catch (e) {
      counts.syncErrors++;
      log("live: trade sync failed:", pool, errorText(e));
    } finally {
      active--;
      syncing.delete(pool);
      if (s.again) wake(pool);
      while (active < SYNC_CONCURRENCY && waiting.length) wake(waiting.shift());
    }
  }

  function statsSoon(pool) {
    if (!db || statsDue.has(pool)) return;
    statsDue.set(
      pool,
      setTimer(() => {
        statsDue.delete(pool);
        db.statsFor(pool)
          .then((row) => row && store.setStats([row]))
          .catch((e) => log("live: stats failed:", errorText(e)));
      }, STATS_DEBOUNCE_MS),
    );
  }
  async function allStats() {
    if (!db) return;
    try {
      store.setStats(await db.allStats(), { full: true });
    } catch (e) {
      log("live: stats failed:", errorText(e));
    }
  }

  function ensureProfile(uri) {
    if (!uri || !fetchProfile) return;
    const st = profileState.get(uri);
    if (st === "ok" || st === "reading" || (typeof st === "number" && now() - st < PROFILE_RETRY_MS)) return;
    profileState.set(uri, "reading");
    fetchProfile(uri)
      .then((body) => {
        profileState.set(uri, "ok");
        // What a card shows: the image and the fee model.
        store.setProfile(uri, { ...(body?.image ? { image: body.image } : {}), ...(body?.sonata ? { sonata: body.sonata } : {}) });
      })
      .catch(() => {
        profileState.set(uri, now());
        if (!store.hasProfile(uri)) store.setProfile(uri, null);
      });
  }

  return {
    onRead,
    /** A trade row the sync just inserted (either path): pushed to its market's pages, and its stats refreshed. */
    onTrade(row) {
      counts.trades++;
      store.publishTrade(row);
      statsSoon(row.pool);
    },
    /** The database side, once migrated: { syncPool, insertPool, recordGraduation, statsFor, allStats }. */
    attach(deps) {
      db = deps;
      void allStats();
      statsTimer = every(() => {
        void allStats();
        for (const e of store.entries()) ensureProfile(e.market.uri);
      }, statsEveryMs);
      for (const e of store.entries()) wake(e.market.pool);
    },
    start() {
      if (running) return;
      running = true;
      loop = (async () => {
        while (running) {
          const started = now();
          await pollOnce();
          await sleep(Math.max(0, pollMs - (now() - started)));
        }
      })();
    },
    async stop() {
      running = false;
      stopEvery(statsTimer);
      for (const t of statsDue.values()) clearTimer(t);
      await loop;
    },
    pollOnce,
    health: () => ({
      running,
      lastPollAt,
      lastError,
      ...counts,
      pollMs: timing.poll.summary(),
      triggeredReadMs: timing.triggeredRead.summary(),
      syncing: active,
      syncWaiting: waiting.length,
      store: store.health(),
    }),
  };
}
