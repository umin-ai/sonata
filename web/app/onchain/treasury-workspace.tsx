"use client";
import { MeteoraLabel } from "@/app/protocol-identity";
import { TokenName } from "@/app/token-identity";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "@/app/plain-link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { ArrowUpRight, RefreshCw } from "lucide-react";
import {
  readTreasuryVerified,
  withPoolFees,
  treasuryReceipts,
  market,
  explorer,
  meteoraPool,
  type TreasurySnapshot,
  readTradingWallet,
  prepareTrade,
  prepareGraduation,
  quoteTrade,
} from "@/lib/treasury/runtime";
import { quoteSymbolOf } from "@/lib/treasury/quote-assets";
import { GraduationProgress } from "./graduation-progress";
import { AIRDROP_PERCENT } from "@/lib/treasury/dbc-preview";
import { StockFloor } from "./stock-floor";
import { CreatorPosition } from "./creator-position";
import { PriceChart, RecentTrades } from "./market-activity";
import { GraduatedSwap, prefetchGraduatedPool } from "./graduated-swap";
import { SwapPanel } from "./swap-panel";
import { FeesView } from "./fees-view";
import { WalletConnectButton } from "./wallet-connect";
import { TokenImage, TokenLinks, useTokenProfile } from "@/app/token-profile-view";
import { LiveWallet, useLive } from "./live-session";
import { useHydrated } from "./snapshot-context";
import type { Market } from "@/lib/treasury/runtime";
import type { CardData } from "@/lib/treasury/market-snapshot";
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
// "3 min ago" from an on-chain unix time, relative to when the data was read.
const sinceText = (seconds: number, now: number) => {
  const mins = Math.max(0, Math.round((now / 1000 - seconds) / 60));
  return mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
};
/**
 * One market's page. `initialData` is the server snapshot's card numbers (at
 * most a minute old), shown until the live read lands. Only the live read,
 * which passes readTreasury's binding check against the chain, enables
 * anything that trades or moves funds; if it fails, the snapshot's numbers are
 * cleared and its error shows.
 */
export function OnchainTreasury({
  selected = market,
  initialData = null,
}: {
  selected?: Market;
  initialData?: CardData | null;
}) {
  const market = selected;
  const q = quoteSymbolOf(market.quoteMint);
  const tokenProfile = useTokenProfile(market.uri);
  const [view, setView] = useState("trade");
  const { address, busy, pending, revision, labels, execute } = useLive();
  const hydrated = useHydrated();
  // The live, verified read; the snapshot's numbers until it lands.
  const [data, setData] = useState<TreasurySnapshot | null>(null),
    [snap, setSnap] = useState<CardData | null>(initialData),
    [receipts, setReceipts] = useState<
      Awaited<ReturnType<typeof treasuryReceipts>>
    >([]),
    [error, setError] = useState(""),
    [walletError, setWalletError] = useState(""),
    [walletBalances, setWalletBalances] = useState<Awaited<
      ReturnType<typeof readTradingWallet>
    > | null>(null),
    [refreshTick, setRefreshTick] = useState(0);
  // Whether a live read has been shown on this page (the first one prefetches the trade panel's pool).
  const shownLive = useRef(false);
  const refresh = useCallback(async () => {
    setError("");
    try {
      // The binding check first: the page shows it as soon as it passes.
      const verified = await readTreasuryVerified(market);
      setSnap(null);
      if (!verified.migrated || !verified.dammPool) {
        shownLive.current = true;
        setData(verified);
        return;
      }
      // A graduated market's pool fees take a few more reads. The first time,
      // the verified read shows meanwhile, and the trade panel's pool read goes
      // first so trading is not held up by them; later, the last full read stays.
      setData((last) => last ?? verified);
      const first = !shownLive.current;
      shownLive.current = true;
      if (first) await prefetchGraduatedPool(market);
      setData(await withPoolFees(market, verified));
    } catch (e) {
      setData(null);
      setSnap(null);
      setError(e instanceof Error ? e.message : "Market data unavailable");
    }
  }, [market]);
  useEffect(() => {
    void refresh();
  }, [refresh, revision]);
  // Receipts only while the Transactions tab is open.
  useEffect(() => {
    if (view !== "history") return;
    let active = true;
    treasuryReceipts(market).then(
      (r) => active && setReceipts(r),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [view, market, revision, refreshTick]);
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
  const balances = walletBalances?.wallet === address ? walletBalances : null;
  // What is shown: the live read, else the snapshot's numbers (display only).
  const shown = data ?? snap;
  // What the fee and backing panels get: the live read once complete (a graduated
  // market's with its pool fees: the snapshot's "uncollected" is the curve's), else
  // a curve market's snapshot after hydration (their countdowns use the time now).
  const feesReady = !!data && (!data.migrated || !data.dammPool || data.poolFees !== null);
  const fees = data ? (feesReady ? data : null) : hydrated && snap && !snap.migrated ? snap : null;
  return (
    <>
      <div className="sr-heading">
        <div>
          <span className="sr-eyebrow">SONATA / TRADE</span>
          <h1 className="token-title">
            {/* The token's own image (or the "?" badge) once, then the pair; only the stock repeats its logo. */}
            <TokenImage profile={tokenProfile} symbol={market.symbol} size={44} />
            <span className="sr-token-pair-label">
              <span className="sr-token-name" style={{ "--token-size": "36px" } as CSSProperties}>
                <b>{market.symbol}</b>
              </span>
              <span className="sr-pair-divider">/</span>
              <TokenName symbol={q} size={36} />
            </span>
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
      {/* As on other launchpads: the chart, the market's details and its trades on the left; the swap on the right, kept in view. */}
      <div className="terminal-trade-main">
        {/* One card: the chart, then the curve's details (the pair is already in the page header). */}
        <Card className="sr-panel terminal-chart-card terminal-market-overview"><PriceChart pool={market.pool} quote={q} revision={revision} supply={shown ? Number(shown.baseSupply) / 1e6 : undefined} /><div className="sr-detail-row"><span>Status</span><Badge variant="outline">{shown ? shown.migrated ? "Graduated" : "Bonding curve" : "Loading"}</Badge></div><GraduationProgress data={shown} quote={q} />{shown?.airdrop && <AirdropRow pool={market.pool} migrated={shown.migrated} />}{shown?.volatilityFee && <div className="sr-detail-row"><span>Volatility fee</span><strong>Up to 20% more on fast moves</strong></div>}<StockFloor data={fees} verified={!!data} market={market} quote={q} held={balances?.base} /><CreatorPosition data={data} market={market} quote={q} /><a className="sr-text-link" href={explorer("address", market.pool)} target="_blank" rel="noreferrer">View pool on explorer <ArrowUpRight size={15}/></a></Card>
      {shown?.migrated && (
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
          {shown.dammPool && (
            <div className="flex flex-wrap gap-3 mt-4">
              <Button asChild>
                <a href={meteoraPool(shown.dammPool)} target="_blank" rel="noreferrer">
                  Trade on Meteora <ArrowUpRight />
                </a>
              </Button>
              <Button asChild variant="outline">
                <Link href={`/earn?net=devnet&pool=${shown.dammPool}`}>Add liquidity</Link>
              </Button>
              <Button asChild variant="ghost">
                <a href={explorer("address", shown.dammPool)} target="_blank" rel="noreferrer">
                  Explorer <ArrowUpRight />
                </a>
              </Button>
            </div>
          )}
        </Card>
      )}
        <Card className="sr-panel terminal-trades-card">
          <span className="sr-eyebrow">RECENT TRADES</span>
          <RecentTrades pool={market.pool} symbol={market.symbol} quote={q} revision={revision} />
        </Card>
      </div>
      <div className="terminal-trade-side">
      {data?.migrated ? (
        // A graduated market trades in its DAMM v2 pool, not on its closed curve.
        <GraduatedSwap market={market} quote={q} balances={balances} baseToken={<span className="sr-token-name"><TokenImage profile={tokenProfile} symbol={market.symbol} size={20} /><b>{market.symbol}</b></span>} />
      ) : data && BigInt(data.quoteReserve) >= BigInt(data.migrationQuoteThreshold) ? (
        // The curve is full: it no longer trades until it moves to its Meteora pool, which anyone can do.
        <Card className="sr-panel swap-panel">
          <strong>The curve is full</strong>
          <div className="swap-rows">
            <div>
              <span>Next</span>
              <strong>Move to its Meteora pool</strong>
            </div>
            <div>
              <span>Liquidity</span>
              <strong>Locked forever, half creator, half Sonata</strong>
            </div>
            <div>
              <span>Who can do it</span>
              <strong>Anyone</strong>
            </div>
          </div>
          {address ? (
            <Button
              className="swap-cta"
              data-side="buy"
              disabled={!!busy || !!pending}
              onClick={() => void execute(() => prepareGraduation(address, market))}
            >
              {busy || `Graduate ${market.symbol}`}
            </Button>
          ) : (
            <WalletConnectButton />
          )}
        </Card>
      ) : (
        <SwapPanel
          market={market}
          quoteSymbol={q}
          balances={balances}
          baseToken={<span className="sr-token-name"><TokenImage profile={tokenProfile} symbol={market.symbol} size={20} /><b>{market.symbol}</b></span>}
          route="Meteora bonding curve"
          fee={data ? { bps: data.tradingFeeBps, dynamic: !!data.volatilityFee } : undefined}
          fillCurve={data && !data.migrated ? BigInt(data.remainingWithFee) : undefined}
          unavailable={data ? undefined : "Reading the market…"}
          quote={(side, amount) => quoteTrade(side, amount, market)}
          prepare={(side, amount) => prepareTrade(side, address, amount, market)}
        />
      )}
      {walletError && <p className="swap-hint" data-tone="error">{walletError}</p>}
      </div></div>}
      {/* What this market has earned, where it goes and what is held: rows, one Collect button. */}
      {view === "fees" && <FeesView market={market} data={fees} verified={!!data} quote={q} feeModel={tokenProfile?.feeModel} held={balances?.base} hasQuote={balances?.hasQuote} />}
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
