"use client";
import { MeteoraLabel } from "@/app/protocol-identity";
import { TokenName, TokenPair } from "@/app/token-identity";
import { useCallback, useEffect, useState } from "react";
import Link from "@/app/plain-link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowUpRight, RefreshCw, ShieldCheck } from "lucide-react";
import {
  isRewardMarket,
  hasFloor,
  readTreasury,
  prepareTreasury,
  treasuryReceipts,
  market,
  explorer,
  meteoraPool,
  type TreasurySnapshot,
  type TreasuryAction,
  readTradingWallet,
  prepareTrade,
  quoteTrade,
} from "@/lib/treasury/runtime";
import { formatUnits } from "@/lib/treasury/units";
import { REWARDS_MINT, quoteSymbolOf } from "@/lib/treasury/quote-assets";
import { GraduationProgress } from "./graduation-progress";
import { AIRDROP_PERCENT } from "@/lib/treasury/dbc-preview";
import { StockFloor } from "./stock-floor";
import { CreatorPosition } from "./creator-position";
import { PriceChart, RecentTrades } from "./market-activity";
import { GraduatedSwap } from "./graduated-swap";
import { SwapPanel } from "./swap-panel";
import { TokenImage, TokenLinks, useTokenProfile } from "@/app/token-profile-view";
import { LiveWallet, useLive } from "./live-session";
import type { Market } from "@/lib/treasury/runtime";
const short = (s: string) => `${s.slice(0, 5)}…${s.slice(-5)}`;
// Reward tokens: the creator's share is sent to Sonata's payout bot, which pays
// holders pro rata. Payouts come from the trade indexer's ledger.
// What Sonata's payout bot has done for a market it pays out: holder rewards or a
// fee module (from the token's metadata), as recorded by the indexer.
type BotPayouts = {
  paid: string;
  payouts: number;
  recipientsLast: number;
  lastPaidAt: number | null;
  feeModel?: string;
  burned?: string;
  lastBuyAt?: number | null;
  winners?: { trader: string; amount: string; rank?: number }[];
  lastRoundAt?: number | null;
  status?: string;
  recipients?: { wallet: string; weight: number; paid?: string }[];
  splitError?: string;
  airdrop?: { status: string; amount?: string; recipients?: number; sentAt?: number | null };
};
// Graduation airdrop: the bot's record of sending the held-back supply.
function AirdropRow({ pool, migrated }: { pool: string; migrated: boolean }) {
  // Read time kept with the answer, so "sent 3 min ago" is measured from when it was read.
  const [airdrop, setAirdrop] = useState<(NonNullable<BotPayouts["airdrop"]> & { readAt: number }) | null>(null);
  useEffect(() => {
    let active = true;
    fetch(`/api/index/rewards?pool=${pool}`)
      .then((r) => (r.ok ? (r.json() as Promise<BotPayouts>) : null))
      .then((d) => {
        if (active) setAirdrop(d?.airdrop ? { ...d.airdrop, readAt: Date.now() } : null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [pool]);
  const state =
    airdrop?.status === "sent"
      ? `sent to ${airdrop.recipients ?? "—"} holders${airdrop.sentAt ? ` ${sinceText(airdrop.sentAt, airdrop.readAt)}` : ""}`
      : migrated
        ? "being airdropped by Sonata's bot"
        : "to holders at graduation";
  return (
    <div className="sr-detail-row">
      <span>Graduation airdrop</span>
      <strong>
        {AIRDROP_PERCENT}% of supply · {state}
      </strong>
    </div>
  );
}
const shortKey = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
function HolderRewardsPanel({
  market,
  sentToBot,
  quote,
  feeModel,
}: {
  market: Market;
  sentToBot: string;
  quote: string;
  feeModel?: string;
}) {
  const [paid, setPaid] = useState<BotPayouts | null>(null);
  useEffect(() => {
    let active = true;
    fetch(`/api/index/rewards?pool=${market.pool}`)
      .then((r) => (r.ok ? (r.json() as Promise<BotPayouts>) : null))
      .then((d) => {
        if (active && d) setPaid(d);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [market.pool]);
  const model = paid?.feeModel ?? feeModel ?? market.feeModel ?? "holders";
  const now = Date.now();
  const last = (t?: number | null, what = "Last payout") => (t ? `${what} ${sinceText(t, now)}.` : "Nothing paid yet.");
  const [eyebrow, title, paidLabel, note] =
    model === "buyback"
      ? [
          "03 / BUYBACK & BURN",
          "Buyback & burn",
          "Spent on buybacks",
          `Buys ${market.symbol} with the fees and burns it about every 15 minutes: on the curve, then in the Meteora pool after graduation. ${last(paid?.lastBuyAt ?? paid?.lastPaidAt, "Last buy")}`,
        ]
      : model === "topBuyers"
        ? [
            "03 / TOP BUYER BOUNTY",
            "Top Buyer Bounty",
            "Paid to buyers",
            `Each 15-minute round, the 3 biggest net buyers win 50% / 30% / 20%. Net = buys − sells; the creator and Sonata are excluded. A round with no net buyers rolls over. ${last(paid?.lastRoundAt ?? paid?.lastPaidAt, "Last round")}`,
          ]
        : model === "lpFarm"
          ? [
              "03 / LP FARM",
              "LP Farm",
              "Paid out",
              `${paid?.status === "lps" ? "Paying liquidity providers in the Meteora pool, pro rata, once their liquidity has been in for a full round" : "Paying holders while on the curve; liquidity providers after graduation"}, about every 15 minutes, in ${quote}. The creator's own wallet is left out. ${last(paid?.lastPaidAt)}`,
            ]
          : model === "split"
            ? [
                "03 / SPLIT",
                "Split",
                "Paid to wallets",
                paid?.splitError
                  ? `This token's split can't be paid (${paid.splitError}). Its share is held, not paid to anyone else.`
                  : `Split by share about every 15 minutes, in ${quote}. ${last(paid?.lastPaidAt)}`,
              ]
            : model === "diamond"
              ? [
                  "03 / DIAMOND HANDS",
                  "Diamond Hands",
                  "Paid to holders",
                  `Paid to holders about every 15 minutes, in ${quote}, weighted by how long they've held: 1× on day one, 1.5× after 24 hours, 2× after 3 days, 3× after 7 days. Selling or moving tokens restarts the clock for that amount, and new tokens start at 1×. The creator's own wallet is left out. ${last(paid?.lastPaidAt)}`,
                ]
              : [
                "03 / PAID TO HOLDERS",
                "Holder rewards",
                "Paid to holders",
                `Paid pro rata to holders of at least 0.01% of the supply, about every 15 minutes, in ${quote}. The creator's own wallet is left out. ${
                  paid?.lastPaidAt
                    ? `Last payout ${sinceText(paid.lastPaidAt, now)} to ${paid.recipientsLast} holders.`
                    : "No payout yet."
                }`,
              ];
  return (
    <Card className="sr-panel">
      <span className="sr-eyebrow">{eyebrow}</span>
      <h3>{title}</h3>
      <div className="sr-position-strip">
        {model === "buyback" && (
          <div>
            <span>Burned</span>
            <strong>
              {paid?.burned ? formatUnits(paid.burned, 6) : "—"} {market.symbol}
            </strong>
          </div>
        )}
        <div>
          <span>{paidLabel}</span>
          <strong>
            {paid ? formatUnits(paid.paid) : "—"} <TokenName symbol={quote} />
          </strong>
        </div>
        <div>
          <span>Collected</span>
          <strong>
            {sentToBot} <TokenName symbol={quote} />
          </strong>
        </div>
      </div>
      {model === "topBuyers" && !!paid?.winners?.length && (
        <div className="bot-list">
          {paid.winners.map((w, i) => (
            <div className="sr-detail-row" key={w.trader}>
              <span>
                {["1st", "2nd", "3rd"][(w.rank ?? i + 1) - 1] ?? `${w.rank ?? i + 1}th`} · {shortKey(w.trader)}
              </span>
              <strong>
                {formatUnits(w.amount)} {quote}
              </strong>
            </div>
          ))}
        </div>
      )}
      {model === "split" && !!paid?.recipients?.length && (
        <div className="bot-list">
          {paid.recipients.map((r) => (
            <div className="sr-detail-row" key={r.wallet}>
              <span>
                {shortKey(r.wallet)} · {Math.round((r.weight / paid.recipients!.reduce((t, x) => t + x.weight, 0)) * 100)}%
              </span>
              <strong>{r.paid ? `${formatUnits(r.paid)} ${quote}` : "—"}</strong>
            </div>
          ))}
        </div>
      )}
      <p className="sr-note">{note}</p>
    </Card>
  );
}
// "3 min ago" from an on-chain unix time, relative to when the data was read.
const sinceText = (seconds: number, now: number) => {
  const mins = Math.max(0, Math.round((now / 1000 - seconds) / 60));
  return mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
};
export function OnchainTreasury({ selected = market }: { selected?: Market }) {
  const market = selected;
  const q = quoteSymbolOf(market.quoteMint);
  const tokenProfile = useTokenProfile(market.uri);
  const [view, setView] = useState("trade");
  const { address, busy, pending, revision, labels, execute } = useLive();
  const [data, setData] = useState<TreasurySnapshot | null>(null),
    [receipts, setReceipts] = useState<
      Awaited<ReturnType<typeof treasuryReceipts>>
    >([]),
    [error, setError] = useState(""),
    [walletError, setWalletError] = useState(""),
    [walletBalances, setWalletBalances] = useState<Awaited<
      ReturnType<typeof readTradingWallet>
    > | null>(null),
    [withdrawAmount, setWithdrawAmount] = useState(""),
    [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(async () => {
    setError("");
    try {
      setData(await readTreasury(market));
      setReceipts(await treasuryReceipts(market));
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Market data unavailable");
    }
  }, [market]);
  useEffect(() => {
    void refresh();
  }, [refresh, revision]);
  useEffect(() => {
    let active = true;
    setWalletBalances(null);
    setWalletError("");
    if (address)
      void readTradingWallet(address, market)
        .then((v) => {
          if (active) setWalletBalances(v);
        })
        .catch((e) => {
          if (active) setWalletError(e.message);
        });
    return () => {
      active = false;
    };
  }, [address, market, revision, refreshTick]);
  const prepare = (action: TreasuryAction) =>
    execute(() => prepareTreasury(action, address, market));
  const enabled = !!address && !busy && !pending;
  const balances = walletBalances?.wallet === address ? walletBalances : null;
  const value = (key: keyof TreasurySnapshot) =>
    data ? formatUnits(String(data[key])) : "—";
  return (
    <>
      <div className="sr-heading">
        <div>
          <span className="sr-eyebrow">SONATA / TRADE</span>
          <h1 className="token-title">
            <TokenImage profile={tokenProfile} symbol={market.symbol} size={44} />
            <TokenPair base={market.symbol} quote={q} size={36} />
          </h1>
          <p>
            {tokenProfile?.description ?? "Trade, view fees and manage your market."}
          </p>
          <TokenLinks profile={tokenProfile} />
        </div>
        <Button
          variant="outline"
          disabled={!!busy}
          onClick={() => {
            void refresh();
            setRefreshTick((v) => v + 1);
          }}
        >
          <RefreshCw />
          Refresh chain data
        </Button>
      </div>
      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Tabs value={view} onValueChange={setView} className="mb-6"><TabsList><TabsTrigger value="trade">Trade</TabsTrigger><TabsTrigger value="fees">Fees & treasury</TabsTrigger><TabsTrigger value="history">Transactions</TabsTrigger></TabsList></Tabs>
      <LiveWallet />
      {view === "trade" && <div className="terminal-trade-layout">
      {/* As on other launchpads: the chart and trades on the left; the swap, then the market's details, on the right. */}
      <div className="terminal-trade-main">
        <Card className="sr-panel terminal-chart-card"><PriceChart pool={market.pool} quote={q} revision={revision} supply={data ? Number(data.baseSupply) / 1e6 : undefined} /></Card>
        <Card className="sr-panel terminal-trades-card">
          <span className="sr-eyebrow">RECENT TRADES</span>
          <RecentTrades pool={market.pool} symbol={market.symbol} quote={q} revision={revision} />
        </Card>
      </div>
      <div className="terminal-trade-side">
      {data?.migrated ? (
        // A graduated market trades in its DAMM v2 pool, not on its closed curve.
        <GraduatedSwap market={market} quote={q} balances={balances} baseToken={<span className="sr-token-name"><TokenImage profile={tokenProfile} symbol={market.symbol} size={20} /><b>{market.symbol}</b></span>} />
      ) : (
        <SwapPanel
          market={market}
          quoteSymbol={q}
          balances={balances}
          baseToken={<span className="sr-token-name"><TokenImage profile={tokenProfile} symbol={market.symbol} size={20} /><b>{market.symbol}</b></span>}
          route="Meteora bonding curve"
          fee={data ? { bps: data.tradingFeeBps, dynamic: !!data.volatilityFee } : undefined}
          unavailable={data ? undefined : "Reading the market…"}
          quote={(side, amount) => quoteTrade(side, amount, market)}
          prepare={(side, amount) => prepareTrade(side, address, amount, market)}
        />
      )}
      {walletError && <p className="swap-hint" data-tone="error">{walletError}</p>}
      <Card className="sr-panel terminal-market-overview"><span className="sr-eyebrow">MARKET DETAILS</span><h2><TokenPair base={market.symbol} quote={q}/></h2><div className="sr-detail-row"><span>Status</span><Badge variant="outline">{data ? data.migrated ? "Graduated" : "Bonding curve" : "Loading"}</Badge></div><GraduationProgress data={data} quote={q} />{data?.airdrop && <AirdropRow pool={market.pool} migrated={data.migrated} />}{data?.volatilityFee && <div className="sr-detail-row"><span>Volatility fee</span><strong>Up to 20% more on fast moves</strong></div>}<StockFloor data={data} market={market} quote={q} held={balances?.base} /><CreatorPosition data={data} market={market} quote={q} /><div className="sr-detail-row"><span>Quote asset</span><TokenName symbol={q}/></div><a className="sr-text-link" href={explorer("address", market.pool)} target="_blank" rel="noreferrer">View pool on explorer <ArrowUpRight size={15}/></a></Card>
      {data?.migrated && (
        <Card className="sr-panel">
          <div className="sr-section-top">
            <div>
              <span className="sr-eyebrow">TRADE</span>
              <h3>Graduated</h3>
            </div>
            <Badge variant="outline">
              <MeteoraLabel>Meteora DAMM v2 · Devnet</MeteoraLabel>
            </Badge>
          </div>
          <p className="sr-note">
            This market completed its bonding curve and moved to a Meteora
            DAMM v2 pool, with its liquidity locked forever. The pool charges
            1%, plus Meteora&apos;s volatility fee on fast moves. Trade it below
            or on Meteora, or add liquidity to its pool on the Pools page.
          </p>
          {data.dammPool && (
            <div className="flex flex-wrap gap-3 mt-4">
              <Button asChild>
                <a href={meteoraPool(data.dammPool)} target="_blank" rel="noreferrer">
                  Trade on Meteora <ArrowUpRight />
                </a>
              </Button>
              <Button asChild variant="outline">
                <Link href={`/earn?net=devnet&pool=${data.dammPool}`}>Add liquidity</Link>
              </Button>
              <Button asChild variant="ghost">
                <a href={explorer("address", data.dammPool)} target="_blank" rel="noreferrer">
                  Explorer <ArrowUpRight />
                </a>
              </Button>
            </div>
          )}
        </Card>
      )}
      </div></div>}
      {/* Where this market's fees go, and the treasury's balances: on the Fees tab, so the trade view starts with the chart and the swap. */}
      {view === "fees" && <>
      <Alert className="mb-6">
        <ShieldCheck />
        <AlertDescription>
          {q} is a valueless mock stock token.{" "}
          {isRewardMarket(market)
            ? `${
                (
                {
                  buyback: `Buyback & burn: half of net trading fees buys ${market.symbol} and burns it`,
                  topBuyers: "Top Buyer Bounty: half of net trading fees goes to each round's top 3 net buyers",
                  lpFarm: `LP Farm: half of net trading fees goes to ${market.symbol} holders, then to liquidity providers after graduation`,
                  split: "Split: half of net trading fees is split between the creator's chosen wallets",
                  diamond: `Diamond Hands: half of net trading fees goes to ${market.symbol} holders, weighted by how long they've held`,
                } as Record<string, string>
              )[tokenProfile?.feeModel ?? market.feeModel ?? ""] ??
                `Reward token: half of net trading fees goes to ${market.symbol} holders`
              }, in ${q}, about every 15 minutes by Sonata's payout bot. The other half goes to Sonata.`
            : market.mode === "standardFloor"
            ? `Backed token: a quarter of net trading fees goes into this market's backing, which any ${market.symbol} holder can burn for their share and the creator can never withdraw. A quarter goes to the creator and half to Sonata.`
            : market.mode === "standard"
              ? "Net trading fees go half to the creator's payout wallet and half to Sonata, paid in the stock."
              : market.mode === "floor"
            ? `Backed token: half of net trading fees goes into this market's backing, which any ${market.symbol} holder can burn for their share and the creator can never withdraw.`
            : market.mode === "refrain"
              ? "All net trading fees go to the creator's payout wallet, paid in the stock."
              : market.quoteMint === REWARDS_MINT
                ? "Half of net trading fees goes to the creator's payout wallet. The other half builds a creator reserve, which the creator can withdraw or put into the ROOM / mSPY pool from the Treasury page."
                : "Half of net trading fees goes to the creator's payout wallet. The other half builds a creator reserve, which only the creator can withdraw."}
        </AlertDescription>
      </Alert>
      <div className="sr-stats">
        <Card>
          <span>Available in Meteora</span>
          <strong>
            {value("uncollected")} <small>{q}</small>
          </strong>
          <small>Uncollected partner fees</small>
        </Card>
        <Card>
          <span>In treasury custody</span>
          <strong>
            {value("custody")} <small>{q}</small>
          </strong>
          <small>Read directly from the token account</small>
        </Card>
        <Card>
          <span>Paid to fixed recipient</span>
          <strong>
            {value("paid")} <small>{q}</small>
          </strong>
          <small>Cumulative contract allocation</small>
        </Card>
      </div>
      </>}
      {view === "fees" && <><div className="sr-community-layout">
        <Card className="sr-panel">
          <span className="sr-eyebrow">01 / EARNED BY TRADING</span>
          <h3>Collect fees</h3>
          <p className="sr-note">
            The treasury program signs a Meteora CPI. Collected {q} goes into
            the treasury’s token account; your wallet only pays the network fee.
          </p>
          <div className="sr-detail-row">
            <span>Collectable now</span>
            <strong>
              {value("uncollected")} <TokenName symbol={q} />
            </strong>
          </div>
          <div className="sr-detail-row">
            <span>Lifetime collected</span>
            <strong>
              {value("claimed")} <TokenName symbol={q} />
            </strong>
          </div>
          <Button
            disabled={
              !enabled ||
              !data ||
              BigInt(data.uncollected) === 0n ||
              data.migrated
            }
            onClick={() => void prepare("collect")}
          >
            Review fee collection
          </Button>
          {data && BigInt(data.uncollected) === 0n && (
            <p className="sr-note mt-3">
              No new fees yet. Refresh after another trade in this Devnet pool.
            </p>
          )}
        </Card>
        <Card className="sr-panel">
          <span className="sr-eyebrow">02 / FIXED AT CREATION</span>
          <h3>Fee distribution</h3>
          <p className="sr-note">
            {market.mode === "standard" ? (
              <>Allocation sends 50% to the fixed recipient and 50% to Sonata.</>
            ) : market.mode === "standardFloor" ? (
              <>Allocation sends 25% to the fixed recipient, 25% into the backing and 50% to Sonata.</>
            ) : market.mode === "refrain" ? (
              <>Allocation sends 100% to the fixed recipient.</>
            ) : (
              <>
                Allocation sends 50% to the fixed recipient. The remaining 50%{" "}
                {market.mode === "floor" ? "goes into the backing" : "stays in custody"}.
              </>
            )}{" "}
            Calling this does not give the caller ownership of those funds.
          </p>
          <div className="sr-detail-row">
            <span>Ready to allocate</span>
            <strong>
              {value("unallocated")} <TokenName symbol={q} />
            </strong>
          </div>
          <div className="sr-detail-row">
            <span>Fixed payout recipient</span>
            <a
              className="sr-text-link"
              href={explorer("address", market.payoutOwner)}
              target="_blank"
              rel="noreferrer"
            >
              {short(market.payoutOwner)} <ArrowUpRight size={14} />
            </a>
          </div>
          <Button
            disabled={!enabled || !data || BigInt(data.unallocated) === 0n}
            onClick={() => void prepare("allocate")}
          >
            Review allocation
          </Button>
          {data && BigInt(data.unallocated) === 0n && (
            <p className="sr-note mt-3">
              All collected fees have been allocated. Collect a new fee batch
              first.
            </p>
          )}
        </Card>
      </div>
      {isRewardMarket(market) ? (
        <HolderRewardsPanel market={market} sentToBot={value("paid")} quote={q} feeModel={tokenProfile?.feeModel} />
      ) : market.mode === "refrain" || market.mode === "standard" ? (
      <Card className="sr-panel">
        <span className="sr-eyebrow">03 / PAID TO CREATOR</span>
        <h3>Creator earnings</h3>
        <div className="sr-position-strip">
          <div>
            <span>Paid to the creator</span>
            <strong>
              {value("paid")} <TokenName symbol={q} />
            </strong>
          </div>
          <div>
            <span>Waiting to be paid</span>
            <strong>
              {value("unallocated")} <TokenName symbol={q} />
            </strong>
          </div>
        </div>
        <p className="sr-note">
          {market.mode === "standard"
            ? "Half of every net fee the treasury collects goes to the creator's fixed payout wallet and half to Sonata. Nothing is held back, so there is no reserve to withdraw."
            : "Every net fee the treasury collects goes to the creator's fixed payout wallet. Nothing is held back, so there is no reserve to withdraw."}
        </p>
        <p className="sr-note">
          Paid automatically: a Sonata bot collects and pays out about every 15 minutes, and anyone can
          press Collect sooner. {data && data.lastClaimTs > 0 ? `Last collected ${sinceText(data.lastClaimTs, data.fetchedAt)}.` : "Nothing collected yet."}
        </p>
      </Card>
      ) : hasFloor(market.mode) ? (
      <Card className="sr-panel">
        <span className="sr-eyebrow">03 / BACKING</span>
        <h3>Held for holders</h3>
        <div className="sr-position-strip">
          <div>
            <span>Backing now</span>
            <strong>
              {value("floor")} <TokenName symbol={q} />
            </strong>
          </div>
          <div>
            <span>Lifetime added</span>
            <strong>
              {value("retained")} <TokenName symbol={q} />
            </strong>
          </div>
          <div>
            <span>Redeemed by holders</span>
            <strong>
              {value("withdrawn")} <TokenName symbol={q} />
            </strong>
          </div>
        </div>
        <p className="sr-note">
          The treasury program refuses any creator withdrawal from this market.
          The only way out is a holder burning {market.symbol} for their share
          in the Trade tab.
        </p>
      </Card>
      ) : (
      <Card className="sr-panel">
        <span className="sr-eyebrow">03 / CREATOR RESERVE</span>
        <h3>Treasury balance</h3>
        <div className="sr-position-strip">
          <div>
            <span>Liquid retained stock</span>
            <strong>
              {value("available")} <TokenName symbol={q} />
            </strong>
          </div>
          <div>
            <span>Lifetime retained</span>
            <strong>
              {value("retained")} <TokenName symbol={q} />
            </strong>
          </div>
          <div>
            <span>Withdrawn by creator</span>
            <strong>
              {value("withdrawn")} <TokenName symbol={q} />
            </strong>
          </div>
        </div>
        <p className="sr-note">
          The deployed Sonata contract lets the creator withdraw this
          reserve. Holding {market.symbol} does not grant redemption rights.
          This balance is not a holder-owned vault, a lending position or earned
          yield.
        </p>
        {market.quoteMint === REWARDS_MINT ? (
        <div className="flex flex-wrap gap-3 mt-2">
          <Button asChild>
            <Link href="/capital">
              Deploy into liquidity <ArrowUpRight />
            </Link>
          </Button>
        </div>
        ) : (
          <p className="sr-note">
            Deploying into liquidity currently uses mSPY, so this
            {" "}{q} reserve can only be withdrawn by the creator.
          </p>
        )}
        {address === market.creator ? (
          <div className="max-w-md mt-4 space-y-3">
            <Label htmlFor="withdraw-amount">
              Withdraw allocated reserve ({q})
            </Label>
            <Input
              id="withdraw-amount"
              inputMode="decimal"
              value={withdrawAmount}
              onChange={(e) => setWithdrawAmount(e.target.value)}
            />
            <Button
              disabled={
                !enabled ||
                !data ||
                BigInt(data.available) === 0n ||
                !withdrawAmount
              }
              onClick={() =>
                void execute(() =>
                  prepareTreasury("withdraw", address, market, withdrawAmount),
                )
              }
            >
              Review withdrawal
            </Button>
          </div>
        ) : (
          <p className="sr-note">
            Only the creator {short(market.creator)} can withdraw this reserve.
          </p>
        )}
      </Card>
      )}
      </>}
      {view === "history" && <Card className="sr-panel">
        <div className="sr-section-top">
          <div>
            <span className="sr-eyebrow">NETWORK RECEIPTS</span>
            <h3>Transaction history</h3>
          </div>
          <Badge variant="outline">
            {data ? `Slot ${data.slot.toLocaleString()}` : "Connecting…"}
          </Badge>
        </div>
        <p className="sr-note">
          Balances are read live on refresh. Receipts below come from the
          treasury’s transaction history.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Operation</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Receipt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {receipts.map((r) => (
              <TableRow key={r.signature}>
                <TableCell>
                  {market.traces.find((t) => t.signature === r.signature)
                    ?.label ??
                    labels[r.signature] ??
                    "Pool / treasury transaction"}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {r.err ? "Failed" : (r.confirmationStatus ?? "Confirmed")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button asChild variant="ghost" size="sm">
                    <a
                      href={explorer("tx", r.signature)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {short(r.signature)}
                      <ArrowUpRight />
                    </a>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!receipts.length && (
          <p className="sr-note">
            No history loaded. Refresh or inspect the treasury directly.
          </p>
        )}
        <div className="sr-actions">
          {[
            ["Pool", market.pool],
            ["Treasury", market.treasury],
            ["Program", market.programId],
            ["Mock stock mint", market.quoteMint],
          ].map(([name, id]) => (
            <Button asChild variant="outline" size="sm" key={name}>
              <a
                href={explorer("address", id)}
                target="_blank"
                rel="noreferrer"
              >
                {name}
                <ArrowUpRight />
              </a>
            </Button>
          ))}
          <Button asChild variant="ghost" size="sm">
            <Link href="/rewards">Explore community rewards</Link>
          </Button>
        </div>
      </Card>}
    </>
  );
}
