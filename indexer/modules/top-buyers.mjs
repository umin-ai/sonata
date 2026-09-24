// "topBuyers" (Top Buyer Bounty): each pass is a round. The round's window runs
// from the end of this pool's last paid round to shortly before now, but never
// back more than an hour, so a stalled crank does not reward stale buys, and
// never past what the indexer has read (see below).
// net = quote spent on buys − quote received from sells, per trader, from the
// indexer's trades table: curve (DBC) trades and, after graduation, trades in
// the market's DAMM v2 pool. A net buyer must also have net-bought base tokens
// (a round trip or a net sell is not a buy, whatever its quote net). The top
// three net buyers get 50% / 30% / 20% of what is owed (rounded down), in the
// quote token, to their existing quote account, if they kept the base tokens
// they net-bought in the round. A share that cannot be paid (fewer than three
// buyers, a winner who did not keep what they bought, or no quote account)
// rolls over; it is never given to the next buyer down. The round ends only
// when someone is paid: its end is stored with the payout's ledger row, so a
// payout that fails or expires also undoes it.
//
// Kept means gained since the round started, not held now: net is per signing
// wallet, and buying with one wallet and selling from another (moving the
// bought tokens there first, or selling tokens the buyer already held) must
// not win. Every pass records the base-token balances of the market's holders
// (ledger kind 'holders', up to BUYER_SNAPSHOT_MAX wallets, no minimum
// holding), and a winner's balance now less its balance at the newest
// snapshot at or before the round's start (0 if it is not in it) must be at
// least what it net-bought in the round, plus what it net-bought between that
// snapshot and the round's start. With no snapshot from before the round's
// start the round does not close this pass.
//
// What this cannot catch: two wallets of one person where one buys and the
// other sells tokens it already held (its own inventory). The buyer's
// balance really did grow by what it bought, and nothing onchain links the
// two wallets, so the buyer wins while the pair's combined holding is
// unchanged (it still pays both trades' fees). A wallet outside the snapshot
// (below the BUYER_SNAPSHOT_MAX largest holders) counts as holding nothing at
// the round's start, so it can pass on tokens it held before up to what the
// smallest wallet in the snapshot holds.
//
// Indexer progress: a trade indexed after its round closed would never count
// in any round, so the round ends no later than the unix second before which
// the indexer has read every trade of the pool (ledger.indexedThrough, from
// modules/indexer-schema.mjs). With no progress yet, or progress more than
// INDEX_STALE_SECONDS old, the round does not close this pass.
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { SONATA_VAULT, VAULT_ADMIN, keySet, onCurve, parseKey } from "./common.mjs";
import { listHolders } from "./holders.mjs";

export const BOUNTY_SHARES_BPS = [5000n, 3000n, 2000n];
// Each pass records the balances of at most this many holder wallets, largest first.
export const BUYER_SNAPSHOT_MAX = 1_000;
// Balance snapshots older than this are dropped (the newest of them is kept):
// a round starts at most BOUNTY_MAX_WINDOW_SECONDS before its end, which is
// at most INDEX_STALE_SECONDS + BOUNTY_SETTLE_SECONDS before now.
export const BUYER_SNAPSHOT_KEEP_SECONDS = 2 * 3600;
// At most this many traders are read for the buys between the round-start snapshot and the round's start.
const GAP_TRADERS = 500;
export const BOUNTY_MAX_WINDOW_SECONDS = 60 * 60;
// Trades of the last minute belong to the next round: the indexer polls every
// 20 seconds, so they may not be in the table yet.
export const BOUNTY_SETTLE_SECONDS = 60;
// Indexer progress older than this means it is behind or down.
export const INDEX_STALE_SECONDS = 10 * 60;

/** The round's [start, end) in unix seconds; `indexedThrough` (unix seconds) caps the end. */
export function bountyWindow({ now, lastRoundEnd = null, indexedThrough = null }) {
  const end = Math.min(Math.floor(now / 1000) - BOUNTY_SETTLE_SECONDS, indexedThrough ?? Infinity);
  const start = Math.max(lastRoundEnd ?? -Infinity, end - BOUNTY_MAX_WINDOW_SECONDS);
  return { start, end };
}

/**
 * net quote bought (`net`) and net base bought (`base`) per trader within
 * [start, end), for traders whose net is positive, largest first (ties by
 * address). Mirrors the ledger's SQL (modules/indexer-schema.mjs buyerNets).
 */
export function netByTrader(trades, { start, end }) {
  const net = new Map();
  for (const t of trades) {
    const time = Math.floor(new Date(t.blockTime ?? t.block_time).getTime() / 1000);
    if (time < start || time >= end) continue;
    const q = BigInt(t.quoteAmount ?? t.quote_amount);
    const b = BigInt(t.baseAmount ?? t.base_amount ?? 0);
    const sign = t.side === "buy" ? 1n : -1n;
    const r = net.get(t.trader) ?? { net: 0n, base: 0n };
    net.set(t.trader, { net: r.net + sign * q, base: r.base + sign * b });
  }
  return [...net].map(([trader, r]) => ({ trader, ...r })).filter((r) => r.net > 0n).sort(byNet);
}
const byNet = (a, b) => (a.net === b.net ? (a.trader < b.trader ? -1 : 1) : a.net > b.net ? -1 : 1);

/**
 * The top three net buyers, excluding the given addresses (the treasury's
 * creator, the crank key, the Vault and its admin), anything that is not a
 * wallet (unparseable or off the ed25519 curve) and any trader whose net base
 * bought is known and not positive (a round trip or a net sell).
 */
export function rankTopBuyers(nets, { excluded = [] } = {}) {
  const skip = keySet([SONATA_VAULT, VAULT_ADMIN, ...excluded]);
  const winners = [];
  for (const r of [...nets].sort(byNet)) {
    if (winners.length === BOUNTY_SHARES_BPS.length) break;
    const key = parseKey(r.trader);
    if (r.net <= 0n || (typeof r.base === "bigint" && r.base <= 0n) || !key || !onCurve(key) || skip.has(r.trader)) continue;
    winners.push({ trader: r.trader, owner: key, net: r.net, ...(r.base === undefined ? {} : { base: r.base }), rank: winners.length + 1 });
  }
  return winners;
}

/** 50/30/20% of owed by rank, rounded down; ranks without a (paid) winner stay owed. */
export function bountyShares(winners, owed) {
  if (owed <= 0n) return [];
  return winners
    .map((w) => ({ ...w, amount: (owed * BOUNTY_SHARES_BPS[w.rank - 1]) / 10_000n }))
    .filter((w) => w.amount > 0n);
}

/** Base atoms `owner` holds now: the sum of its classic SPL token accounts for the base mint. */
export async function baseHeld({ connection, rpc }, baseMint, owner) {
  const { value: listed } = await rpc(() => connection.getTokenAccountsByOwner(owner, { mint: baseMint }, "confirmed"));
  let held = 0n;
  for (const { pubkey, account } of listed) {
    try {
      const a = unpackAccount(new PublicKey(pubkey), account, TOKEN_PROGRAM_ID);
      if (a.mint.equals(baseMint) && a.owner.equals(owner)) held += a.amount;
    } catch {
      // not a token account of this mint
    }
  }
  return held;
}

/**
 * The winners who kept the base tokens they net-bought in the round, and why
 * each other one is out: a winner's balance now less its balance in `start`
 * (the round-start snapshot, { amounts: Map wallet → base atoms }; 0 if not
 * in it) must be at least its base bought in the round plus `gap` (Map
 * wallet → base net-bought between that snapshot and the round's start, when
 * positive). A winner whose base amount is unknown (a ledger without it)
 * cannot be checked, and one who net-bought no base (zero or less) did not
 * buy: neither is paid.
 */
export async function stillHolding(ctx, winners, { start = null, gap = new Map() } = {}) {
  const holding = [], out = [];
  for (const w of winners) {
    if (typeof w.base !== "bigint") out.push({ ...w, why: "base bought unknown" });
    else if (w.base <= 0n) out.push({ ...w, why: "no base net-bought" });
    else {
      const held = await baseHeld(ctx, ctx.m.baseMint, w.owner);
      const before = start?.amounts.get(w.trader) ?? 0n;
      const earlier = gap.get(w.trader) ?? 0n;
      const need = w.base + (earlier > 0n ? earlier : 0n);
      const kept = held - before;
      if (kept >= need) holding.push(w);
      else out.push({ ...w, held, why: `kept ${kept < 0n ? 0n : kept} of the ${need} base atoms bought (holds ${held}, held ${before} before the round)` });
    }
  }
  return { holding, out };
}

const hasSnapshots = (ledger) => ["recordSnapshot", "pruneSnapshots", "previousSnapshot"].every((f) => typeof ledger[f] === "function");

/** Records the market's holder balances for this pass (unix seconds `at`): a later round's start. */
export async function recordBuyerBalances(ctx, at) {
  const { ledger, m } = ctx;
  const pool = m.pool.toBase58();
  const holders = await listHolders(ctx, { max: BUYER_SNAPSHOT_MAX, minHoldingDivisor: null });
  await ledger.recordSnapshot(pool, "holders", at, holders.map((h) => [h.owner.toBase58(), h.balance]));
  await ledger.pruneSnapshots(pool, "holders", BUYER_SNAPSHOT_KEEP_SECONDS, at);
}

/** A pass that does not pay a topBuyers market still records its balances. */
export async function observeTopBuyers(ctx) {
  if (ctx.dryRun || !hasSnapshots(ctx.ledger)) return;
  await recordBuyerBalances(ctx, Math.floor((ctx.now ?? Date.now)() / 1000));
}

/**
 * The indexer's progress for the pool (unix seconds), or why the round cannot
 * close this pass. undefined when the ledger does not report progress (the
 * round then ends on the clock alone, as before progress existed).
 */
async function progressOf(ledger, pool, nowSeconds) {
  if (typeof ledger.indexedThrough !== "function") return { through: undefined };
  let through;
  try {
    through = await ledger.indexedThrough(pool);
  } catch (e) {
    return { skip: `indexer progress unreadable (${String(e?.message ?? e).slice(0, 120)}); the round stays open, the pot rolls over` };
  }
  if (through === null || through === undefined)
    return { skip: "the indexer has not read this pool's trades yet (or its graduated pool's); the round stays open, the pot rolls over" };
  if (nowSeconds - through > INDEX_STALE_SECONDS)
    return { skip: `the indexer is ${nowSeconds - through}s behind; the round stays open, the pot rolls over` };
  return { through };
}

export async function runTopBuyers(ctx) {
  const { m, owed, ledger, authority, excludedOwners, fields, dryRun, now = Date.now } = ctx;
  const pool = m.pool.toBase58();
  const at = now();
  if (!hasSnapshots(ledger)) return { skip: "ledger has no balance snapshots, so no winner can be checked; the round stays open, the pot rolls over" };
  // This pass's balances, whatever happens below: a later round's start.
  if (!dryRun) await recordBuyerBalances(ctx, Math.floor(at / 1000));
  const progress = await progressOf(ledger, pool, Math.floor(at / 1000));
  fields.indexedThrough = progress.through === undefined ? "unknown" : progress.through;
  if (progress.skip) return { skip: progress.skip };
  const lastRoundEnd = await ledger.lastRoundEnd(pool);
  const { start, end } = bountyWindow({ now: at, lastRoundEnd, indexedThrough: progress.through ?? null });
  Object.assign(fields, { roundStart: start, roundEnd: end });
  if (end <= start) return { skip: "round too short; next pass" };
  const nets = await ledger.buyerNets(pool, start, end);
  const ranked = rankTopBuyers(nets, { excluded: [m.creator, authority.publicKey, ...excludedOwners] });
  fields.buyers = nets.length;
  if (!ranked.length) return { skip: "no net buyers this round; the pot rolls over" };
  // Balances at the round's start: the newest snapshot taken at or before it.
  const baseline = await ledger.previousSnapshot(pool, "holders", start + 1);
  if (!baseline) return { skip: "no balance snapshot from before the round's start yet; the round stays open, the pot rolls over" };
  fields.balancesAt = baseline.takenAt;
  const gap = new Map();
  if (baseline.takenAt < start)
    for (const r of await ledger.buyerNets(pool, baseline.takenAt, start, GAP_TRADERS)) if (typeof r.base === "bigint" && r.base > 0n) gap.set(r.trader, r.base);
  const { holding: winners, out } = await stillHolding(ctx, ranked, { start: baseline, gap });
  if (out.length) fields.notHolding = out.length;
  const outNote = out.length ? `not paid, share rolls over: ${out.map((w) => `rank ${w.rank} ${w.trader} (${w.why})`).join(", ")}` : undefined;
  if (!winners.length) return { skip: "no winner still holds what they bought this round; the pot rolls over", ...(outNote ? { note: outNote } : {}) };
  const shares = bountyShares(winners, owed);
  fields.winners = winners.length;
  await ctx.payShares(shares.map((s) => ({ ...s, balance: s.net })), {
    module: "topBuyers",
    emptyNote: "no winner has a quote account; the pot rolls over and the round continues",
    detailOf: (batch) => ({
      roundStart: start,
      roundEnd: end,
      winners: batch.map((i) => ({ trader: i.payout.trader, rank: i.payout.rank, net: i.payout.net, amount: i.payout.amount })),
    }),
  });
  return outNote ? { note: outNote } : {};
}
