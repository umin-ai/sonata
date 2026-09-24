// "diamond" (Diamond Hands): the holders module, with each holder's weight
// multiplied by how long they have held: under 24 hours 1x, from 24 hours 1.5x,
// from 3 days 2x, from 7 days 3x. Tenure starts at the later of the wallet's
// first indexed buy and its last indexed sell on this pool (any sell restarts
// the clock). A holder with no indexed trades (tokens received by transfer) is
// 1x. Every holder rule is the holders module's (see selectHolders).
const HOUR = 3600;
// Multipliers in halves, so the weights stay whole numbers.
export const TENURE_TIERS = [
  { seconds: 7 * 24 * HOUR, halves: 6n, label: "3" },
  { seconds: 3 * 24 * HOUR, halves: 4n, label: "2" },
  { seconds: 24 * HOUR, halves: 3n, label: "1.5" },
];
const BASE_TIER = { seconds: 0, halves: 2n, label: "1" };
export const MULTIPLIERS = ["1", "1.5", "2", "3"];

/** Unix seconds the holding clock started, or null without indexed trades. */
export function tenureStart({ firstBuy = null, lastSell = null } = {}) {
  if (firstBuy == null && lastSell == null) return null;
  return Math.max(firstBuy ?? -Infinity, lastSell ?? -Infinity);
}

/** The tier for a clock that started at `start` (null: 1x). */
export function tierFor(start, now) {
  if (start == null) return BASE_TIER;
  const held = now - start;
  return TENURE_TIERS.find((t) => held >= t.seconds) ?? BASE_TIER;
}

/**
 * Holders ({ owner, balance }) weighted by tenure: balance becomes
 * balance × multiplier (in halves; only ratios matter), `held` keeps the
 * balance and `multiplier` the tier. `tenures` maps owner → { firstBuy, lastSell }.
 */
export function diamondWeights(holders, tenures, now) {
  return holders.map((h) => {
    const tier = tierFor(tenureStart(tenures.get(h.owner.toBase58())), now);
    return { ...h, held: h.balance, balance: h.balance * tier.halves, multiplier: tier.label };
  });
}

export const multiplierCounts = (weighted) =>
  Object.fromEntries(MULTIPLIERS.map((label) => [label, weighted.filter((w) => w.multiplier === label).length]));

export async function runDiamond(ctx) {
  const { m, ledger, fields, now = Date.now } = ctx;
  let counts = null;
  await ctx.payHolders({
    module: "diamond",
    weigh: async (holders) => {
      const tenures = await ledger.tenure(m.pool.toBase58(), holders.map((h) => h.owner.toBase58()));
      const weighted = diamondWeights(holders, tenures, Math.floor(now() / 1000));
      counts = multiplierCounts(weighted);
      fields.multipliers = MULTIPLIERS.map((l) => `${l}x:${counts[l]}`).join(",");
      return weighted;
    },
    detail: () => ({ multipliers: counts }),
  });
  return {};
}
