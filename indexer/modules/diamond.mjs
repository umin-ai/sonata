// "diamond" (Diamond Hands): the holders module, with each holder's balance
// weighted by how long it has been held: under 24 hours 1x, from 24 hours
// 1.5x, from 3 days 2x, from 7 days 3x. How long is read from the crank's own
// balance snapshots (one per pass, whether or not the market is paid; ledger
// kind 'holders'), not from indexed trades, so transfers and trading after
// graduation (DAMM v2) count the same as curve trades. For a window D:
//   H(D) = the least the wallet held at any snapshot over the last D, or 0
//          unless it was among the holders at every snapshot back to one at
//          least D old (a new market's holders start at 1x);
//   weight = 3 H(7d) + 2 (H(3d) - H(7d)) + 1.5 (H(24h) - H(3d)) + 1 (balance - H(24h)).
// So selling or moving out any amount restarts the clock for the amount that
// left, and tokens bought or received count 1x until they have been held.
// Every holder rule is the holders module's (see selectHolders): a wallet
// that drops out of the top 200 or below 0.01% of supply restarts too.
import { listHolders } from "./holders.mjs";

const HOUR = 3600;
const DAY = 24 * HOUR;
// Multipliers in halves, so the weights stay whole numbers. Longest first.
export const TENURE_TIERS = [
  { seconds: 7 * DAY, halves: 6n, label: "3" },
  { seconds: 3 * DAY, halves: 4n, label: "2" },
  { seconds: DAY, halves: 3n, label: "1.5" },
];
const BASE_TIER = { seconds: 0, halves: 2n, label: "1" };
export const MULTIPLIERS = ["1", "1.5", "2", "3"];
// The windows H(D) is read for, in seconds.
export const TENURE_WINDOWS = TENURE_TIERS.map((t) => t.seconds);
// Snapshots older than the longest window are dropped (the newest of them is kept as its start).
export const SNAPSHOT_KEEP_SECONDS = 7 * DAY;

const min = (a, b) => (a < b ? a : b);

/**
 * [H(7d), H(3d), H(24h)] for a wallet holding `balance` now: `lows` maps each
 * window (seconds) to the least it held over that window before now (absent:
 * not held throughout), capped by the balance now, and never more than the
 * shorter window's.
 */
export function tenured(balance, lows) {
  let cap = balance;
  return [...TENURE_WINDOWS].reverse().map((d) => (cap = min(cap, lows?.get(d) ?? 0n))).reverse();
}

/** The weight in halves: 6 H(7d) + 4 (H(3d) - H(7d)) + 3 (H(24h) - H(3d)) + 2 (balance - H(24h)). */
export function tenureWeight(balance, lows) {
  const [h7, h3, h1] = tenured(balance, lows);
  return 6n * h7 + 4n * (h3 - h7) + 3n * (h1 - h3) + 2n * (balance - h1);
}

/** The highest tier the whole balance averages at least (for display). */
export function tierOf(balance, weight) {
  if (balance <= 0n) return BASE_TIER;
  return TENURE_TIERS.find((t) => weight >= balance * t.halves) ?? BASE_TIER;
}

/**
 * Holders ({ owner, balance }) weighted by tenure: balance becomes the weight
 * in halves (only ratios matter), `held` keeps the balance and `multiplier`
 * the tier it averages. `lows` maps owner → (window → least held), as
 * ledger.heldMinimums returns it.
 */
export function diamondWeights(holders, lows) {
  return holders.map((h) => {
    const weight = tenureWeight(h.balance, lows.get(h.owner.toBase58()));
    return { ...h, held: h.balance, balance: weight, multiplier: tierOf(h.balance, weight).label };
  });
}

export const multiplierCounts = (weighted) =>
  Object.fromEntries(MULTIPLIERS.map((label) => [label, weighted.filter((w) => w.multiplier === label).length]));

/** Records this pass's holder balances (unix seconds `at`) and drops snapshots no window needs. */
export async function recordHolders(ledger, pool, at, holders) {
  await ledger.recordSnapshot(pool, "holders", at, holders.map((h) => [h.owner.toBase58(), h.balance]));
  await ledger.pruneSnapshots(pool, "holders", SNAPSHOT_KEEP_SECONDS, at);
}

const passTime = (ctx) => Math.floor((ctx.now ?? Date.now)() / 1000);

export async function runDiamond(ctx) {
  const { m, ledger, fields, dryRun } = ctx;
  const pool = m.pool.toBase58();
  const at = passTime(ctx);
  const holders = await listHolders(ctx);
  // The history before this pass, then this pass's snapshot (a dry run writes nothing).
  const lows = await ledger.heldMinimums(pool, "holders", holders.map((h) => h.owner.toBase58()), at, TENURE_WINDOWS);
  if (!dryRun) await recordHolders(ledger, pool, at, holders);
  const weighted = diamondWeights(holders, lows);
  const counts = multiplierCounts(weighted);
  fields.multipliers = MULTIPLIERS.map((l) => `${l}x:${counts[l]}`).join(",");
  await ctx.payHolders({ module: "diamond", holders: weighted, detail: () => ({ multipliers: counts }) });
  return {};
}

/** A pass that does not pay the market still takes its snapshot, so tenure has no gaps. */
export async function observeDiamond(ctx) {
  if (ctx.dryRun) return;
  await recordHolders(ctx.ledger, ctx.m.pool.toBase58(), passTime(ctx), await listHolders(ctx));
}
