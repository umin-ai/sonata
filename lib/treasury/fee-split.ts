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

export type ShareContext = {
  wallet: string;
  creator: string;
  payoutOwner: string;
  mode: TreasuryMode;
  reward: boolean;
  /** The reward token's fee module (holders, diamond, lpFarm, topBuyers, buyback, split). */
  feeModel?: string;
  /** The wallet's balance of the token, and the token's total supply, in base atoms. */
  held: bigint;
  supply: bigint;
  /** LP Farm pays liquidity providers once the token has graduated. */
  lpPhase?: boolean;
  /** Split module: the creator's chosen wallets and their weights. */
  splitRecipients?: { wallet: string; weight: number }[];
  /** Whether the wallet has a token account for the stock: the bot pays holders only into an existing one. */
  canReceive?: boolean;
  /** The stock's symbol, for the text. */
  stock?: string;
};

/**
 * Whether the connected wallet gets anything from this token's fees, and how,
 * in a few words: collecting fees (by anyone) never pays the person who
 * presses the button, only the shares below. Follows the payout bot's rules
 * (indexer/modules/holders.mjs, lp-farm.mjs): holder modules pay up to 200
 * holders of at least 0.01% of the supply who have an account for the stock,
 * the creator's own wallet is left out, and LP Farm pays liquidity providers
 * once the bot has switched to them. The balance is one token account's, and
 * the bot sums all of a wallet's accounts, so this can understate a share.
 */
export function yourShare(c: ShareContext): { text: string; yours: boolean } {
  const shares = feeSplit(c.mode, { reward: c.reward, feeModel: c.feeModel });
  const pct = (to: FeeShare["to"]) => shares.find((s) => s.to === to)?.percent ?? 0;
  const none = (why: string) => ({ text: `None · ${why}`, yours: false });
  const backed = c.mode === "floor" || c.mode === "standardFloor";
  if (!c.reward) {
    const parts = [];
    if (c.payoutOwner === c.wallet) parts.push(`${pct("creator")}% to your wallet`);
    else if (c.creator === c.wallet)
      parts.push(`${pct("creator")}% to your payout wallet ${c.payoutOwner.slice(0, 4)}…${c.payoutOwner.slice(-4)}`);
    if (c.creator === c.wallet && c.mode === "duet") parts.push(`${pct("reserve")}% to your reserve`);
    if (parts.length) return { text: parts.join(" · "), yours: true };
    if (backed && c.held > 0n) return { text: "No payout · it adds to the backing under your tokens", yours: true };
    if (backed) return none("hold the token to own part of the backing");
    return none("this token pays its creator, not holders");
  }
  const model = c.feeModel ?? "holders";
  const creatorOut = c.wallet === c.creator;
  if (model === "buyback") return none("it buys the token and burns it");
  if (model === "split") {
    const total = (c.splitRecipients ?? []).reduce((t, r) => t + r.weight, 0);
    const mine = c.splitRecipients?.find((r) => r.wallet === c.wallet);
    return mine && total
      ? { text: `${Math.round((pct("bot") * mine.weight) / total)}% · via Sonata's bot`, yours: true }
      : none("it goes to the creator's chosen wallets");
  }
  if (model === "topBuyers")
    return creatorOut
      ? none("the creator is left out")
      : { text: "Only if you're a top 3 net buyer this round", yours: false };
  if (creatorOut) return none("the creator's wallet is left out");
  if (model === "lpFarm" && c.lpPhase) return { text: "Only as a liquidity provider in the pool", yours: false };
  if (c.held <= 0n) return none("hold the token to earn");
  if (c.supply > 0n && c.held * 10_000n < c.supply) return none("you hold under 0.01% of the supply");
  if (c.canReceive === false) return none(`the bot pays only wallets with a ${c.stock ?? "stock"} account`);
  return {
    text:
      model === "diamond"
        ? "As a holder (top 200), weighted by how long you've held"
        : "As a holder (top 200), by your share of tokens",
    yours: true,
  };
}
