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
  hasFloor,
  readTreasury,
  prepareTreasury,
  treasuryReceipts,
  market,
  explorer,
  type TreasurySnapshot,
  type TreasuryAction,
  type TradeSide,
  readTradingWallet,
  prepareTrade,
} from "@/lib/treasury/runtime";
import { formatUnits } from "@/lib/treasury/units";
import { REWARDS_MINT, quoteSymbolOf } from "@/lib/treasury/quote-assets";
import { GraduationProgress } from "./graduation-progress";
import { StockFloor } from "./stock-floor";
import { CreatorPosition } from "./creator-position";
import { PriceChart, RecentTrades } from "./market-activity";
import { TokenImage, TokenLinks, useTokenProfile } from "@/app/token-profile-view";
import { LiveWallet, useLive } from "./live-session";
import type { Market } from "@/lib/treasury/runtime";
const short = (s: string) => `${s.slice(0, 5)}…${s.slice(-5)}`;
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
    [side, setSide] = useState<TradeSide>("buy"),
    [amount, setAmount] = useState("0.001"),
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
  const prepareSwap = () =>
    execute(() => prepareTrade(side, address, amount, market));
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
      <Alert className="mb-6">
        <ShieldCheck />
        <AlertDescription>
          {q} is a valueless mock stock token.{" "}
          {market.mode === "standardFloor"
            ? `A quarter of net trading fees builds this market's Stock Floor, which any ${market.symbol} holder can redeem and the creator cannot withdraw. A quarter goes to the creator and half to Sonata.`
            : market.mode === "standard"
              ? "Net trading fees go half to the creator's payout wallet and half to Sonata, paid in the stock."
              : market.mode === "floor"
            ? `Half of net trading fees builds this market's Stock Floor, which any ${market.symbol} holder can redeem and the creator cannot withdraw.`
            : market.mode === "refrain"
              ? "All net trading fees go to the creator's payout wallet, paid in the stock."
              : "Collected creator reserves can fund liquidity positions or fixed community rewards."}
        </AlertDescription>
      </Alert>
      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
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
      <Tabs value={view} onValueChange={setView} className="mb-6"><TabsList><TabsTrigger value="trade">Trade</TabsTrigger><TabsTrigger value="fees">Fees & treasury</TabsTrigger><TabsTrigger value="history">Transactions</TabsTrigger></TabsList></Tabs>
      <LiveWallet />
      {view === "trade" && <div className="terminal-trade-layout"><Card className="sr-panel terminal-market-overview"><span className="sr-eyebrow">MARKET DETAILS</span><h2><TokenPair base={market.symbol} quote={q}/></h2><div className="sr-detail-row"><span>Status</span><Badge variant="outline">{data ? data.migrated ? "Graduated" : "Bonding curve" : "Loading"}</Badge></div><GraduationProgress data={data} quote={q} /><StockFloor data={data} market={market} quote={q} held={balances?.base} /><CreatorPosition data={data} market={market} quote={q} /><div className="sr-detail-row"><span>Quote asset</span><TokenName symbol={q}/></div><PriceChart pool={market.pool} quote={q} revision={revision} supply={data ? Number(data.baseSupply) / 1e6 : undefined} /><a className="sr-text-link" href={explorer("address", market.pool)} target="_blank" rel="noreferrer">View pool on explorer <ArrowUpRight size={15}/></a></Card>
      {data?.migrated ? (
        // A graduated pool no longer trades on its DBC curve; the runtime refuses
        // such a swap. Say so here rather than after the user fills in the form.
        <Card className="sr-panel mb-6">
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
            This market completed its bonding curve and migrated to a Meteora
            DAMM v2 pool, so it no longer trades here. Swapping on the new pool
            from this page is not connected yet.
          </p>
          {data.dammPool && (
            <Button asChild variant="outline" className="mt-4">
              <a href={explorer("address", data.dammPool)} target="_blank" rel="noreferrer">
                View the DAMM v2 pool <ArrowUpRight />
              </a>
            </Button>
          )}
        </Card>
      ) : (
      <Card className="sr-panel mb-6">
        <div className="sr-section-top">
          <div>
            <span className="sr-eyebrow">START HERE / TRADE</span>
            <h3>Swap</h3>
          </div>
          <Badge variant="outline">
            <MeteoraLabel>Meteora DBC · Devnet</MeteoraLabel>
          </Badge>
        </div>
        <p className="sr-note">
          Swap {q} and {market.symbol} in the existing pool. Trading produces
          fees in {q} that the treasury can collect below. These are test
          assets, with no real stock exposure.
        </p>
        <Tabs
          value={side}
          onValueChange={(v) => {
            setSide(v as TradeSide);
            setAmount("");
          }}
        >
          <TabsList aria-label="Trade direction">
            <TabsTrigger value="buy" disabled={!!busy}>
              Buy <TokenName symbol={market.symbol} />
            </TabsTrigger>
            <TabsTrigger value="sell" disabled={!!busy}>
              Sell <TokenName symbol={market.symbol} />
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3 [&_span]:block [&_span]:text-xs [&_span]:text-muted-foreground [&_strong]:block [&_strong]:break-all [&_strong]:text-lg">
          <div>
            <span>
              Your <TokenName symbol={q} />
            </span>
            <strong>{balances ? formatUnits(balances.quote, 8) : "—"}</strong>
          </div>
          <div>
            <span>
              Your <TokenName symbol={market.symbol} />
            </span>
            <strong>{balances ? formatUnits(balances.base, 6) : "—"}</strong>
          </div>
          <div>
            <span>Devnet SOL</span>
            <strong>{balances ? formatUnits(balances.sol, 9) : "—"}</strong>
          </div>
        </div>
        {walletError && (
          <p className="sr-note" role="alert">
            {walletError}
          </p>
        )}
        <div className="max-w-md space-y-3 mt-5">
          <Label htmlFor="trade-amount">
            You pay ({side === "buy" ? q : market.symbol})
          </Label>
          <Input
            id="trade-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder={side === "buy" ? "0.01" : "100"}
            value={amount}
            disabled={!!busy}
            onChange={(e) => setAmount(e.target.value)}
          />
          <p className="sr-note">
            0.5% slippage limit · quote expires after 30 seconds. Review shows
            the minimum you receive and estimated network costs.
          </p>
          <Button
            disabled={
              !enabled || !data || !balances || data.migrated || !amount
            }
            onClick={() => void prepareSwap()}
          >
            Review {side === "buy" ? "buy" : "sell"}
          </Button>
        </div>
        {!address && (
          <p className="sr-note mt-3">Connect a test wallet above to start.</p>
        )}
        {balances && BigInt(balances.quote) === 0n && (
          <p className="sr-note mt-3">
            This wallet needs the {q} mock mint linked below. The real tokenized
            stock is not supported by this Devnet pool.
          </p>
        )}
      </Card>
      )}</div>}
      {view === "trade" && (
        <Card className="sr-panel mt-6">
          <span className="sr-eyebrow">RECENT TRADES</span>
          <RecentTrades pool={market.pool} symbol={market.symbol} quote={q} revision={revision} />
        </Card>
      )}
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
              <>Allocation sends 25% to the fixed recipient, 25% into the Stock Floor and 50% to Sonata.</>
            ) : market.mode === "refrain" ? (
              <>Allocation sends 100% to the fixed recipient.</>
            ) : (
              <>
                Allocation sends 50% to the fixed recipient. The remaining 50%{" "}
                {market.mode === "floor" ? "goes into the Stock Floor" : "stays in custody"}.
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
      {market.mode === "refrain" || market.mode === "standard" ? (
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
        <span className="sr-eyebrow">03 / STOCK FLOOR</span>
        <h3>Held for holders</h3>
        <div className="sr-position-strip">
          <div>
            <span>Floor now</span>
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
          <Button asChild variant="outline">
            <Link href="/rewards">
              Fund member rewards <ArrowUpRight />
            </Link>
          </Button>
        </div>
        ) : (
          <p className="sr-note">
            Liquidity deployment and holder rewards currently use mSPY, so this
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
