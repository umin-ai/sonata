// "topBuyers" (Top Buyer Bounty): each pass is a round. The round's window runs
// from the end of this pool's last paid round to shortly before now, but never
// back more than an hour, so a stalled crank does not reward stale buys, and
// never past what the indexer has read (see below).
// net = quote spent on buys − quote received from sells, per trader, from the
// indexer's trades table: curve (DBC) trades and, after graduation, trades in
// the market's DAMM v2 pool. The top three net buyers get 50% / 30% / 20% of
// what is owed (rounded down), in the quote token, to their existing quote
// account, if they still hold the base tokens they net-bought in the round
// (net is per signing wallet: buying with one wallet and selling from another
// must not win). A share that cannot be paid (fewer than three buyers, a winner
// who no longer holds, or no quote account) rolls over; it is never given to
// the next buyer down. The round ends only when someone is paid: its end is
// stored with the payout's ledger row, so a payout that fails or expires also
// undoes it.
//
// Indexer progress: a trade indexed after its round closed would never count
// in any round, so the round ends no later than the unix second before which
// the indexer has read every trade of the pool (ledger.indexedThrough, from
// modules/indexer-schema.mjs). With no progress yet, or progress more than
// INDEX_STALE_SECONDS old, the round does not close this pass.
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { SONATA_VAULT, VAULT_ADMIN, keySet, onCurve, parseKey } from "./common.mjs";

export const BOUNTY_SHARES_BPS = [5000n, 3000n, 2000n];
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
 * creator, the crank key, the Vault and its admin) and anything that is not a
 * wallet (unparseable or off the ed25519 curve).
 */
export function rankTopBuyers(nets, { excluded = [] } = {}) {
  const skip = keySet([SONATA_VAULT, VAULT_ADMIN, ...excluded]);
  const winners = [];
  for (const r of [...nets].sort(byNet)) {
    if (winners.length === BOUNTY_SHARES_BPS.length) break;
    const key = parseKey(r.trader);
    if (r.net <= 0n || !key || !onCurve(key) || skip.has(r.trader)) continue;
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
 * The winners who still hold at least the base tokens they net-bought in the
 * round, and why each other one is out. A winner whose base amount is unknown
 * (a ledger without it) cannot be checked, so is not paid.
 */
export async function stillHolding(ctx, winners) {
  const holding = [], out = [];
  for (const w of winners) {
    if (typeof w.base !== "bigint") out.push({ ...w, why: "base bought unknown" });
    else if (w.base <= 0n) holding.push(w);
    else {
      const held = await baseHeld(ctx, ctx.m.baseMint, w.owner);
      if (held >= w.base) holding.push(w);
      else out.push({ ...w, held, why: `holds ${held} of the ${w.base} base atoms bought` });
    }
  }
  return { holding, out };
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
  const { m, owed, ledger, authority, excludedOwners, fields, now = Date.now } = ctx;
  const pool = m.pool.toBase58();
  const at = now();
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
  const { holding: winners, out } = await stillHolding(ctx, ranked);
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
