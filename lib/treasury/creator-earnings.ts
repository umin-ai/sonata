// What each token a wallet launched (or is paid by) has earned that wallet, and
// what is waiting, for the My tokens page. Amounts are stock atoms; totals are
// kept per stock, since tokens trade against different stocks.
import { feeSplit } from "./fee-split.ts";
import type { TreasuryMode } from "./runtime";

export type EarningsInput = {
  mode: TreasuryMode;
  /** The stock this token trades against (its quote symbol). */
  stock: string;
  creator: string;
  payoutOwner: string;
  /** Reward tokens pay the creator's share to Sonata's bot instead. */
  reward: boolean;
  paid: bigint;
  /** Fees still in Meteora (the curve, or Sonata's half of the pool). */
  uncollected: bigint;
  /** Fees collected into the treasury and not yet paid out. */
  unallocated: bigint;
  /** A creator reserve's withdrawable balance (duet mode). */
  available: bigint;
  /** The creator's own locked pool half, after graduation. */
  position?: { unclaimed: bigint; claimed: bigint } | null;
};

export type TokenEarnings = {
  /** Percent of each collected fee that reaches this wallet (payout share, plus the reserve for its creator). */
  sharePercent: number;
  paidToYou: bigint;
  waiting: bigint;
  yourWaiting: bigint;
  poolToClaim: bigint;
  poolClaimed: bigint;
  reserve: bigint;
};

export function tokenEarnings(t: EarningsInput, wallet: string): TokenEarnings {
  const paysYou = !t.reward && t.payoutOwner === wallet;
  const shares = feeSplit(t.mode, { reward: t.reward });
  const payoutPercent = paysYou ? (shares.find((s) => s.to === "creator")?.percent ?? 0) : 0;
  const reservePercent = t.creator === wallet ? (shares.find((s) => s.to === "reserve")?.percent ?? 0) : 0;
  const sharePercent = payoutPercent + reservePercent;
  const waiting = t.uncollected + t.unallocated;
  const mine = t.creator === wallet;
  return {
    sharePercent,
    paidToYou: paysYou ? t.paid : 0n,
    waiting,
    yourWaiting: (waiting * BigInt(sharePercent)) / 100n,
    poolToClaim: mine ? (t.position?.unclaimed ?? 0n) : 0n,
    poolClaimed: mine ? (t.position?.claimed ?? 0n) : 0n,
    reserve: mine && t.mode === "duet" ? t.available : 0n,
  };
}

export type EarningsTotals = Record<
  "earned" | "yourWaiting" | "poolToClaim" | "reserve",
  Map<string, bigint>
>;

/** Per-stock totals: earned so far (payouts plus pool fees claimed), waiting, to claim, in reserves. */
export function earningsTotals(rows: { stock: string; earnings: TokenEarnings }[]): EarningsTotals {
  const totals: EarningsTotals = { earned: new Map(), yourWaiting: new Map(), poolToClaim: new Map(), reserve: new Map() };
  const add = (m: Map<string, bigint>, stock: string, v: bigint) => {
    if (v > 0n) m.set(stock, (m.get(stock) ?? 0n) + v);
  };
  for (const { stock, earnings: e } of rows) {
    add(totals.earned, stock, e.paidToYou + e.poolClaimed);
    add(totals.yourWaiting, stock, e.yourWaiting);
    add(totals.poolToClaim, stock, e.poolToClaim);
    add(totals.reserve, stock, e.reserve);
  }
  return totals;
}
