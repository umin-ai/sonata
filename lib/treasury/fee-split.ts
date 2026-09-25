// Where a market's collected fees go, as the treasury program splits them
// (distribute, or distribute_split in the Standard modes), and what each share
// has received so far, worked out from the treasury's running totals:
//   paid      the creator's payout wallet (Sonata's payout bot for reward tokens)
//   retained  everything else booked out of the fees: the backing, the creator
//             reserve, and in the Standard modes Sonata's share too
//   withdrawn what has left the retained balance: reserve withdrawals, holder
//             redemptions, and in the Standard modes Sonata's share (booked as
//             retained and withdrawn at once)
import type { TreasuryMode } from "./runtime";

export type FeeShare = {
  to: "creator" | "bot" | "sonata" | "backing" | "reserve";
  label: string;
  percent: number;
  /** Stock atoms this share has received, when the totals are given. */
  received?: bigint;
};
export type FeeTotals = { paid: bigint; retained: bigint; withdrawn: bigint };

// What Sonata's payout bot does with a reward token's share, by fee module.
export const BOT_SHARE_LABEL: Record<string, string> = {
  buyback: "Buyback & burn",
  topBuyers: "Top 3 buyers",
  lpFarm: "Holders, then LPs",
  split: "Creator's wallets",
  diamond: "Long-term holders",
};

/** The shares of `mode`, in the order the program pays them. */
export function feeSplit(
  mode: TreasuryMode,
  { reward = false, feeModel, totals }: { reward?: boolean; feeModel?: string; totals?: FeeTotals } = {},
): FeeShare[] {
  const t = totals;
  const got = (v: () => bigint) => (t ? v() : undefined);
  const creator = (percent: number): FeeShare =>
    reward
      ? { to: "bot", label: BOT_SHARE_LABEL[feeModel ?? ""] ?? "Holders", percent, received: got(() => t!.paid) }
      : { to: "creator", label: "Creator", percent, received: got(() => t!.paid) };
  switch (mode) {
    case "standard":
      return [creator(50), { to: "sonata", label: "Sonata", percent: 50, received: got(() => t!.retained) }];
    case "standardFloor":
      // The creator's and the backing's shares are the same 25%, rounded the same way.
      return [
        creator(25),
        { to: "backing", label: "Backing", percent: 25, received: got(() => t!.paid) },
        { to: "sonata", label: "Sonata", percent: 50, received: got(() => t!.retained - t!.paid) },
      ];
    case "floor":
      return [creator(50), { to: "backing", label: "Backing", percent: 50, received: got(() => t!.retained) }];
    case "refrain":
      return [creator(100)];
    case "duet":
      return [creator(50), { to: "reserve", label: "Creator reserve", percent: 50, received: got(() => t!.retained) }];
  }
}

/** Stock atoms holders have taken out of the backing by burning (floor modes only). */
export function redeemed(mode: TreasuryMode, t: FeeTotals) {
  if (mode === "floor") return t.withdrawn;
  if (mode === "standardFloor") return t.withdrawn - (t.retained - t.paid);
  return 0n;
}
