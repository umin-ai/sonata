// "topBuyers" (Top Buyer Bounty): each pass is a round. The round's window runs
// from the end of this pool's last paid round to shortly before now, but never
// back more than an hour, so a stalled crank does not reward stale buys.
// net = quote spent on buys − quote received from sells, per trader, from the
// indexer's trades table. The top three net buyers get 50% / 30% / 20% of what
// is owed (rounded down), in the quote token, to their existing quote account.
// A share that cannot be paid (fewer than three buyers, or no quote account)
// rolls over. The round ends only when someone is paid: its end is stored with
// the payout's ledger row, so a payout that fails or expires also undoes it.
import { SONATA_VAULT, VAULT_ADMIN, keySet, onCurve, parseKey } from "./common.mjs";

export const BOUNTY_SHARES_BPS = [5000n, 3000n, 2000n];
export const BOUNTY_MAX_WINDOW_SECONDS = 60 * 60;
// Trades of the last minute belong to the next round: the indexer polls every
// 20 seconds, so they may not be in the table yet.
export const BOUNTY_SETTLE_SECONDS = 60;

/** The round's [start, end) in unix seconds. */
export function bountyWindow({ now, lastRoundEnd = null }) {
  const end = Math.floor(now / 1000) - BOUNTY_SETTLE_SECONDS;
  const start = Math.max(lastRoundEnd ?? -Infinity, end - BOUNTY_MAX_WINDOW_SECONDS);
  return { start, end };
}

/**
 * net quote bought per trader within [start, end), for traders whose net is
 * positive, largest first (ties by address). Mirrors the ledger's SQL.
 */
export function netByTrader(trades, { start, end }) {
  const net = new Map();
  for (const t of trades) {
    const time = Math.floor(new Date(t.blockTime ?? t.block_time).getTime() / 1000);
    if (time < start || time >= end) continue;
    const q = BigInt(t.quoteAmount ?? t.quote_amount);
    net.set(t.trader, (net.get(t.trader) ?? 0n) + (t.side === "buy" ? q : -q));
  }
  return [...net].map(([trader, n]) => ({ trader, net: n })).filter((r) => r.net > 0n).sort(byNet);
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
    winners.push({ trader: r.trader, owner: key, net: r.net, rank: winners.length + 1 });
  }
  return winners;
}

/** 50/30/20% of owed by rank, rounded down; ranks without a winner stay owed. */
export function bountyShares(winners, owed) {
  if (owed <= 0n) return [];
  return winners
    .map((w, i) => ({ ...w, amount: (owed * BOUNTY_SHARES_BPS[i]) / 10_000n }))
    .filter((w) => w.amount > 0n);
}

export async function runTopBuyers(ctx) {
  const { m, owed, ledger, authority, excludedOwners, fields, now = Date.now } = ctx;
  const pool = m.pool.toBase58();
  const lastRoundEnd = await ledger.lastRoundEnd(pool);
  const { start, end } = bountyWindow({ now: now(), lastRoundEnd });
  Object.assign(fields, { roundStart: start, roundEnd: end });
  if (end <= start) return { skip: "round too short; next pass" };
  const nets = await ledger.buyerNets(pool, start, end);
  const winners = rankTopBuyers(nets, { excluded: [m.creator, authority.publicKey, ...excludedOwners] });
  fields.buyers = nets.length;
  if (!winners.length) return { skip: "no net buyers this round; the pot rolls over" };
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
  return {};
}

