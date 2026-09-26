// The live market store behind live push: every market's raw accounts as the
// indexer last saw them, the entries decoded from them, and the frames pushed
// to open pages (modules/stream.mjs), all under one version counter.
//
// Accounts come from the market accounts reader's full reads (every 10 s, and
// right after a new Sonata transaction) and from the live module's 1 s pool
// reads. Each account is kept with the newest slot it was seen at, so a read
// served by a node that lags never replaces a newer value, and with the slot
// its current data was first seen at, which dates the entry (`version`).
//
// Entries are decoded with the app's own code (`decode` is
// lib/treasury/snapshot-decode.ts snapshotFromAccounts, the function the app's
// server uses), one market at a time, only when one of its accounts changed.
// So the listing rule runs in one place: a market is pushed as `added` the
// first time it decodes as listed, and nothing is pushed for markets that are
// not listed. A market that stops decoding (numbers become an error, or it is
// no longer listed) is not pushed until a fresh read of its accounts says the
// same (`suspects`, re-read by the live module): a half-updated view of a
// claim, say, never shows as an error.
//
// Frames: every change is one frame with the next sequence number `seq`, in a
// ring buffer (the last 5,000 frames or 5 minutes) that reconnecting pages
// resume from. The market list gets each market's changes at most once a
// second, with only the fields a card shows; a market page gets every change
// of its market in full, and its trades. `epoch` (the process start) tells a
// page that the sequence started over.
import { PublicKey } from "@solana/web3.js";
import { marketKeys, sharedKeys, treasuryFields } from "./market-accounts.mjs";

export const LIST_UPDATE_EVERY_MS = 1_000;
export const RING_FRAMES = 5_000;
export const RING_MS = 5 * 60_000;
/** A treasury missing from this many full reads in a row is dropped (none should ever be: treasuries are never closed). */
export const MISSING_READS_BEFORE_DROP = 6;
/** A market page that missed more trades than this gets a snapshot instead of a replay. */
export const MAX_REPLAY_TRADES = 100;
/** What a market card shows (app/onchain/live-directory.tsx): all a market list update carries. */
export const CARD_FIELDS = [
  "slot",
  "marketCap",
  "milestoneCaps",
  "graduationBps",
  "graduationStage",
  "heat",
  "migrated",
  "quoteReserve",
  "migrationQuoteThreshold",
  "remainingToGraduate",
  "remainingWithFee",
  "floor",
  "baseSupply",
  "mode",
  "airdrop",
  "volatilityFee",
  "dammPool",
];

const pick = (data) => Object.fromEntries(CARD_FIELDS.filter((k) => k in data).map((k) => [k, data[k]]));
const same = (a, b) =>
  a === b || (!!a && !!b && a.data === b.data && a.owner === b.owner && a.lamports === b.lamports && a.executable === b.executable);
const errorText = (e) => String(e?.message ?? e).slice(0, 300);
/** The market list's order (lib/treasury/market-snapshot.ts newestFirst): newest launch first, unknown last, then by pool. */
export const newestFirst = (a, b) => {
  const x = a.launchedAt ?? -1,
    y = b.launchedAt ?? -1;
  return x !== y ? y - x : a.market.pool < b.market.pool ? -1 : a.market.pool > b.market.pool ? 1 : 0;
};
// What makes two entries different for a page: everything but the decode time.
const signature = (e) => JSON.stringify([e.market, e.data && { ...e.data, fetchedAt: 0 }, e.error ?? null, e.launchedAt ?? null]);

export function marketStore({
  decode,
  programId,
  now = Date.now,
  epoch = now().toString(36),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  listEveryMs = LIST_UPDATE_EVERY_MS,
  ringFrames = RING_FRAMES,
  ringMs = RING_MS,
  missingReads = MISSING_READS_BEFORE_DROP,
  log = (...a) => console.error(...a),
}) {
  const program = String(programId);
  // key -> { a: account | null, seen: newest slot seen, since: slot its data was first seen at }
  const accounts = new Map();
  // treasury -> { treasury, pool, uri, keys, entry, sig, missing, gone }
  const markets = new Map();
  const byPool = new Map();
  const owners = new Map();
  const skipped = new Map();
  const stats = new Map();
  const profiles = new Map();
  let order = [];
  let info = { readAt: 0, slot: 0, ms: 0, calls: 0, source: null, registered: 0 };
  let ready = false,
    liveAt = 0,
    seq = 0,
    evictedThrough = 0,
    viewJson = null;
  const frames = [];
  const frameListeners = new Set(),
    readyListeners = new Set();
  // The market list's throttle: when each market last went out, its pending update, and whether it went out with numbers.
  const listAt = new Map(),
    listTimers = new Map(),
    listHadData = new Map();

  function frame(event, scope, pool, data) {
    const f = { seq: ++seq, t: now(), event, scope, pool, data };
    frames.push(f);
    while (frames.length > ringFrames || (frames.length && f.t - frames[0].t > ringMs)) evictedThrough = frames.shift().seq;
    for (const fn of frameListeners)
      try {
        fn(f);
      } catch (e) {
        log("live frame listener failed:", errorText(e));
      }
    return f;
  }

  const profileOf = (uri) => (uri && profiles.has(uri) ? profiles.get(uri) : undefined);
  const addedPayload = (entry) => {
    const pool = entry.market.pool;
    const profile = profileOf(entry.market.uri);
    return {
      pool,
      kind: "added",
      version: entry.version ?? entry.data?.slot ?? 0,
      entry,
      stats: stats.get(pool) ?? null,
      ...(profile !== undefined ? { profile } : {}),
    };
  };

  function emitList(pool) {
    listTimers.delete(pool);
    const t = byPool.get(pool),
      entry = t && markets.get(t)?.entry;
    if (!entry) return;
    const body = entry.data
      ? listHadData.get(pool)
        ? { card: pick(entry.data) }
        : { data: entry.data }
      : { card: null, error: entry.error ?? "Chain data unavailable" };
    listHadData.set(pool, !!entry.data);
    listAt.set(pool, now());
    frame("market", "list", pool, { pool, kind: "updated", version: entry.version ?? entry.data?.slot ?? 0, ...body });
  }

  function publishAdded(entry) {
    const pool = entry.market.pool;
    clearTimer(listTimers.get(pool));
    listTimers.delete(pool);
    listAt.set(pool, now());
    listHadData.set(pool, !!entry.data);
    frame("market", "all", pool, addedPayload(entry));
  }

  function publishUpdated(entry) {
    const pool = entry.market.pool;
    frame("market", "market", pool, {
      pool,
      kind: "updated",
      version: entry.version ?? entry.data?.slot ?? 0,
      data: entry.data,
      ...(entry.error ? { error: entry.error } : {}),
    });
    // The list: now if its last update is a second old, else once that second is up (with the numbers then current).
    if (listTimers.has(pool)) return;
    const wait = (listAt.get(pool) ?? -Infinity) + listEveryMs - now();
    if (wait <= 0) emitList(pool);
    else listTimers.set(pool, setTimer(() => emitList(pool), wait));
  }

  function publishRemoved(pool, reason) {
    clearTimer(listTimers.get(pool));
    listTimers.delete(pool);
    listAt.delete(pool);
    listHadData.delete(pool);
    frame("removed", "all", pool, { pool, reason });
  }

  // A treasury's market, from its account: its pool and the keys its card is decoded from. False if unreadable.
  function register(treasury, account) {
    let t;
    try {
      t = treasuryFields(Buffer.from(String(account?.data ?? ""), "base64"));
    } catch {
      return false;
    }
    const keys = [...marketKeys(new PublicKey(treasury), t), ...sharedKeys(t.quoteMint.toBase58(), program)];
    const m = { treasury, pool: t.pool.toBase58(), keys, entry: null, sig: null, missing: 0, gone: false };
    markets.set(treasury, m);
    byPool.set(m.pool, treasury);
    for (const k of keys) {
      if (!owners.has(k)) owners.set(k, new Set());
      owners.get(k).add(treasury);
    }
    return true;
  }

  function unregister(m) {
    markets.delete(m.treasury);
    if (byPool.get(m.pool) === m.treasury) byPool.delete(m.pool);
    skipped.delete(m.treasury);
    for (const k of m.keys) {
      const set = owners.get(k);
      set?.delete(m.treasury);
      if (set && !set.size) {
        owners.delete(k);
        accounts.delete(k);
      }
    }
  }

  // One account as seen at `slot`: kept unless an older view; true when its data changed.
  function put(key, account, fallbackSlot) {
    const slot = account ? Number(account.slot) || 0 : fallbackSlot;
    const cur = accounts.get(key);
    if (cur && slot < cur.seen) return false;
    if (cur && same(cur.a, account)) {
      cur.seen = slot;
      return false;
    }
    accounts.set(key, { a: account, seen: slot, since: slot });
    return true;
  }

  const affected = (keys) => {
    const out = new Set();
    for (const k of keys) for (const t of owners.get(k) ?? []) out.add(t);
    return out;
  };

  function changed() {
    viewJson = null;
  }

  const entries = () => [...markets.values()].filter((m) => m.entry).map((m) => m.entry).sort(newestFirst);
  const entryOf = (pool) => {
    const t = byPool.get(pool);
    return (t && markets.get(t)?.entry) || null;
  };

  return {
    get epoch() {
      return epoch;
    },
    get seq() {
      return seq;
    },
    get ready() {
      return ready;
    },

    /**
     * A full read (the market accounts reader's): its accounts merged by slot,
     * new treasuries registered, and treasuries it no longer lists counted
     * towards being dropped. Returns the treasuries to decode.
     */
    mergeRead(read) {
      info = {
        readAt: read.readAt,
        slot: read.slot,
        ms: read.ms ?? 0,
        calls: read.calls ?? 0,
        source: read.source ?? null,
        registered: read.registered ?? read.treasuries.length,
      };
      const todo = new Set();
      const listed = new Set(read.treasuries);
      for (const t of read.treasuries) {
        const m = markets.get(t);
        if (m) {
          m.missing = 0;
          m.gone = false;
        } else if (register(t, read.accounts[t])) todo.add(t);
      }
      const keys = [];
      for (const [key, account] of Object.entries(read.accounts)) if (put(key, account, read.slot)) keys.push(key);
      for (const t of affected(keys)) todo.add(t);
      for (const [t, m] of markets)
        if (!listed.has(t) && ++m.missing >= missingReads) {
          m.gone = true;
          todo.add(t);
        }
      order = [...read.treasuries, ...[...markets.keys()].filter((t) => !listed.has(t))];
      changed();
      return [...todo];
    },

    /** Accounts read outside a full read (1 s pool reads, re-reads): merged by slot. Returns the treasuries to decode. */
    patch(entries) {
      const keys = [];
      for (const [key, account] of entries) if (owners.has(key) && put(key, account, account?.slot ?? 0)) keys.push(key);
      if (keys.length) {
        liveAt = now();
        changed();
      }
      return [...affected(keys)];
    },

    /**
     * Decodes these treasuries' markets and pushes what changed. A market
     * that would go from numbers to an error or off the list, or that would be
     * listed for the first time without numbers, is returned in `suspects`
     * instead, unless in `confirm` (a fresh read already said so).
     */
    decode(treasuries, { confirm = new Set() } = {}) {
      const events = [],
        suspects = [];
      for (const t of treasuries) {
        const m = markets.get(t);
        if (!m) continue;
        if (m.gone) {
          unregister(m);
          if (m.entry) {
            publishRemoved(m.pool, "no longer registered");
            events.push({ kind: "removed", pool: m.pool });
          }
          changed();
          continue;
        }
        const subset = {};
        for (const k of m.keys) {
          const cur = accounts.get(k);
          if (cur) subset[k] = cur.a && { ...cur.a, slot: cur.since };
        }
        let out;
        try {
          out = decode({ v: 1, readAt: info.readAt, slot: info.slot, treasuries: [t], accounts: subset });
        } catch (e) {
          out = { entries: [], skipped: [{ pool: t, reason: errorText(e) }] };
        }
        const next = out.entries[0] ?? null;
        if (out.skipped?.length) skipped.set(t, out.skipped);
        else skipped.delete(t);
        const prev = m.entry;
        const bad = !next || !next.data;
        if (bad && !confirm.has(t) && (prev?.data || (!prev && next))) {
          suspects.push(t);
          continue;
        }
        if (!next) {
          if (prev) {
            m.entry = null;
            m.sig = null;
            publishRemoved(m.pool, out.skipped?.[0]?.reason ?? "not listed");
            events.push({ kind: "removed", pool: m.pool });
            changed();
          }
          continue;
        }
        const sig = signature(next);
        if (sig === m.sig) continue;
        m.entry = next;
        m.sig = sig;
        m.uri = next.market.uri;
        changed();
        if (!prev) {
          publishAdded(next);
          events.push({ kind: "added", pool: m.pool, treasury: t, entry: next });
        } else {
          publishUpdated(next);
          events.push({ kind: "updated", pool: m.pool, treasury: t, entry: next, prev });
        }
      }
      // Ready once the first full read is decoded: snapshots from then on hold its markets.
      if (!ready && info.readAt) {
        ready = true;
        changed();
        for (const fn of readyListeners) fn();
      }
      return { events, suspects };
    },

    /** 24h stats rows (the indexer's /stats shape): each row that changed is pushed. */
    setStats(rows) {
      for (const row of rows) {
        if (!row?.pool) continue;
        const text = JSON.stringify(row);
        if (JSON.stringify(stats.get(row.pool) ?? null) === text) continue;
        stats.set(row.pool, row);
        frame("stats", "all", row.pool, { pool: row.pool, stats: row });
      }
    },
    /** A token profile (image and fee model; null: unreadable), pushed to the pages of the markets that use it. */
    setProfile(uri, profile) {
      profiles.set(uri, profile);
      for (const m of markets.values()) if (m.entry && m.entry.market.uri === uri) frame("profile", "all", m.pool, { pool: m.pool, uri, profile });
    },
    hasProfile: (uri) => profiles.has(uri),
    /** A market as a page that missed its changes should get it now: `added` with its entry, or `removed`. */
    current(pool) {
      const e = entryOf(pool);
      return e ? { event: "market", data: addedPayload(e) } : { event: "removed", data: { pool, reason: "not listed" } };
    },
    /** A trade row just indexed (the /trades shape plus pool), pushed to its market's pages. */
    publishTrade(row) {
      frame("trade", "market", row.pool, { pool: row.pool, trade: row });
    },

    onFrame(fn) {
      frameListeners.add(fn);
      return () => frameListeners.delete(fn);
    },
    onReady(fn) {
      if (ready) fn();
      else readyListeners.add(fn);
      return () => readyListeners.delete(fn);
    },

    entries,
    entryOf,
    treasuryOf: (pool) => byPool.get(pool) ?? null,
    poolOf: (treasury) => markets.get(treasury)?.pool ?? null,
    /** The keys a treasury's card is decoded from, and the newest slot any of them was seen at. */
    groupOf(treasury) {
      const m = markets.get(treasury);
      if (!m) return null;
      return { keys: m.keys, slot: Math.max(0, ...m.keys.map((k) => accounts.get(k)?.seen ?? 0)) };
    },
    statsRows: () => [...stats.values()],

    /**
     * The accounts each 1 s read should cover, at most `max`: per listed
     * market its DBC pool, or once graduated its DAMM v2 pool (trades only);
     * markets traded in the last 24 h first, then the newest.
     */
    pollKeys(max) {
      const traded = (pool) => Number(stats.get(pool)?.trades_24h ?? 0) > 0;
      const listed = [...markets.values()].filter((m) => m.entry).map((m) => m.entry);
      listed.sort((a, b) => Number(traded(b.market.pool)) - Number(traded(a.market.pool)) || newestFirst(a, b));
      const out = [];
      for (const e of listed) {
        if (out.length >= max) break;
        if (e.data?.migrated) {
          if (e.data.dammPool) out.push({ key: e.data.dammPool, pool: e.market.pool, venue: "damm" });
        } else out.push({ key: e.market.pool, pool: e.market.pool, venue: "dbc" });
      }
      return out;
    },

    /** The /api/index/accounts answer: the raw view, its decoded entries, and the stream position; serialized once per change. */
    view: () => {
      if (!ready) return null;
      viewJson ??= JSON.stringify({
        v: 1,
        ...info,
        treasuries: order.filter((t) => markets.has(t)),
        accounts: Object.fromEntries([...accounts].map(([k, { a, since }]) => [k, a && { ...a, slot: since }])),
        epoch,
        seq,
        liveAt,
        entries: entries(),
        skipped: [...skipped.values()].flat(),
      });
      return viewJson;
    },

    /** Everything a page needs to start from (a stream's `snapshot` frame). */
    snapshot: (scope, pool) => {
      if (scope === "market") {
        const entry = entryOf(pool);
        const profile = profileOf(entry?.market.uri);
        return { seq, pool, entry, stats: stats.get(pool) ?? null, ...(profile !== undefined ? { profile } : {}) };
      }
      const listed = entries();
      const shownProfiles = {};
      for (const e of listed) {
        const p = profileOf(e.market.uri);
        if (p !== undefined) shownProfiles[e.market.uri] = p;
      }
      return { seq, entries: listed, skipped: [...skipped.values()].flat().length, stats: [...stats.values()], profiles: shownProfiles };
    },

    /**
     * What a page that has seen everything up to `since` missed, compacted:
     * each market that changed as it is now, its page's trades in order, and
     * the full 24h stats (a quiet market's stats move with the clock, not with
     * frames). Null when the ring buffer no longer covers `since`, or a market
     * page missed too many trades: it gets a snapshot instead.
     */
    replay: (since, scope, pool) => {
      if (!Number.isSafeInteger(since) || since < evictedThrough || since > seq) return null;
      const pools = new Set(),
        trades = [];
      for (const f of frames) {
        if (f.seq <= since) continue;
        if (scope === "market" ? f.pool !== pool || f.scope === "list" : f.scope === "market") continue;
        if (f.event === "trade") trades.push(f.data);
        else if (f.event === "market" || f.event === "removed" || f.event === "profile") pools.add(f.pool);
      }
      if (trades.length > MAX_REPLAY_TRADES) return null;
      const out = [];
      for (const p of pools) {
        const e = entryOf(p);
        out.push(e ? { event: "market", data: addedPayload(e) } : { event: "removed", data: { pool: p, reason: "not listed" } });
      }
      for (const t of trades) out.push({ event: "trade", data: t });
      const rows = scope === "market" ? (stats.has(pool) ? [stats.get(pool)] : []) : [...stats.values()];
      out.push({ event: "stats", data: { full: true, pools: rows } });
      return out;
    },

    health: () => ({
      ready,
      epoch,
      seq,
      markets: [...markets.values()].filter((m) => m.entry).length,
      registered: info.registered,
      accounts: accounts.size,
      frames: frames.length,
      readAt: info.readAt,
      liveAt,
    }),
  };
}
