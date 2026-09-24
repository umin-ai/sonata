"use client";
import { Flame, Gem, Gift, PartyPopper, ShieldCheck, Split, Sprout, Trophy, Zap, type LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AIRDROP_PERCENT } from "@/lib/treasury/dbc-preview";
import { formatUnits } from "@/lib/treasury/units";
import { hasFloor, isRewardMarket, type Market, type TreasurySnapshot } from "@/lib/treasury/runtime";

// A market's features as small icons on its card, so every card keeps one height:
// Backed token (its backing on hover), Reward token or fee module, and the launch
// extras. Hover or focus an icon for what it means.
const MODULES: Record<string, [LucideIcon, string, string]> = {
  holders: [Gift, "Reward token", "Holders are paid from every trade."],
  buyback: [Flame, "Buyback & burn", "Fees buy the token and burn it."],
  topBuyers: [Trophy, "Top Buyer Bounty", "Each round's 3 biggest buyers win."],
  lpFarm: [Sprout, "LP Farm", "Holders, then liquidity providers after graduation."],
  split: [Split, "Split", "The creator's share is split between wallets."],
  diamond: [Gem, "Diamond Hands", "Holders, paid more the longer they hold."],
};

type Badge = { key: string; Icon: LucideIcon; title: string; line: string; tone?: string };
// The treasury snapshot's launch fields. Mode and backing are optional, so a
// list that reads only the DBC config (the Pools page) can show the icons too.
type BadgeData = Pick<TreasurySnapshot, "airdrop" | "volatilityFee"> &
  Partial<Pick<TreasurySnapshot, "mode" | "floor">>;

export function MarketBadges({
  market,
  data,
  feeModel,
  quote,
}: {
  market: Market;
  data: BadgeData | null;
  feeModel?: string;
  quote: string;
}) {
  const badges: Badge[] = [];
  if (hasFloor(market.mode) || hasFloor(data?.mode))
    badges.push({
      key: "backed",
      Icon: ShieldCheck,
      title: "Backed token",
      line: `${data?.floor !== undefined ? `${formatUnits(data.floor)} ${quote} of backing. ` : ""}Any holder can burn for their share.`,
      tone: "backed",
    });
  if (isRewardMarket(market)) {
    const [Icon, title, line] = MODULES[feeModel ?? market.feeModel ?? "holders"] ?? MODULES.holders;
    badges.push({ key: "model", Icon, title, line, tone: "model" });
  }
  if (data?.airdrop)
    badges.push({
      key: "airdrop",
      Icon: PartyPopper,
      title: "Graduation airdrop",
      line: `${AIRDROP_PERCENT}% of the supply goes to holders at graduation.`,
    });
  if (data?.volatilityFee)
    badges.push({ key: "volatility", Icon: Zap, title: "Volatility fee", line: "Up to 20% more fee on fast moves." });
  if (!badges.length) return null;
  return (
    <TooltipProvider>
      <span className="market-badges">
        {badges.map(({ key, Icon, title, line, tone }) => (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <span className="market-badge" data-tone={tone} tabIndex={0} aria-label={`${title}. ${line}`}>
                <Icon size={13} aria-hidden />
              </span>
            </TooltipTrigger>
            <TooltipContent sideOffset={4} className="max-w-[240px]">
              <strong>{title}</strong> · {line}
            </TooltipContent>
          </Tooltip>
        ))}
      </span>
    </TooltipProvider>
  );
}
