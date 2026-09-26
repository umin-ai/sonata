"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, Lock, RefreshCw, Sprout } from "lucide-react";
import Link from "@/app/plain-link";
import { MeteoraLabel } from "@/app/protocol-identity";
import { TokenName } from "@/app/token-identity";
import { TokenImage, useTokenProfile } from "@/app/token-profile-view";
import { MarketBadges } from "@/app/onchain/market-badges";
import { LiveWallet, useLive } from "@/app/onchain/live-session";
import { WalletConnectButton } from "@/app/onchain/wallet-connect";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  discoverMarkets,
  explorer,
  meteoraPool,
  isRewardMarket,
  readTradingWallet,
  type Market,
} from "@/lib/treasury/runtime";
import { formatUnits, parseUnits } from "@/lib/treasury/units";
import {
  depositLimits,
  displayAmount,
  listGraduatedPools,
  maxDeposit,
  preparePoolClaim,
  preparePoolDeposit,
  preparePoolWithdrawal,
  priceRatioBps,
  quoteDeposit,
  RESERVE_PRICE_GAP_BPS,
  readPoolPositions,
  type GraduatedPool,
  type PoolList,
  type PoolPosition,
} from "@/lib/liquidity/pools";
import type { TokenProfile } from "@/lib/token-profile";
import { MainnetPools, useMainnetPools } from "./mainnet-pools";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const marketHref = (m: Market) => `/onchain?pool=${m.pool}`;
const percent = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
// LP Farm is a fee module, so it only runs for markets paid out by Sonata's bot.
const isLpFarm = (m: Market, feeModel?: string) =>
  isRewardMarket(m) && (feeModel ?? m.feeModel) === "lpFarm";

// Every graduated pool, re-read after each confirmed transaction or on Refresh.
// The last list stays on screen while a refresh loads.
function usePoolList() {
  const { revision } = useLive();
  const [nonce, setNonce] = useState(0);
  const key = `${revision}:${nonce}`;
  const [read, setRead] = useState<{ key: string; list?: PoolList; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    discoverMarkets()
      .then(listGraduatedPools)
      .then(
        (list) => active && setRead({ key, list }),
        (e) =>
          active &&
          setRead((last) => ({ key, list: last?.list, error: message(e, "Pools unavailable.") })),
      );
    return () => {
      active = false;
    };
  }, [key]);
  return {
    list: read?.list,
    error: read?.key === key ? read.error : undefined,
    loading: read?.key !== key,
    refresh: () => setNonce((n) => n + 1),
  };
}

// The wallet's positions in every listed pool, in one read.
function usePositions(address: string, list?: PoolList) {
  const [read, setRead] = useState<{
    address: string;
    list: PoolList;
    positions?: Map<string, PoolPosition[]>;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!address || !list?.pools.length) return;
    let active = true;
    readPoolPositions(address, list.pools).then(
      (positions) => active && setRead({ address, list, positions }),
      (e) => active && setRead({ address, list, error: message(e, "Positions unavailable.") }),
    );
    return () => {
      active = false;
    };
  }, [address, list]);
  const current = read && read.address === address && read.list === list ? read : null;
  return {
    positions: current?.positions,
    error: current?.error,
    loading: !!address && !!list?.pools.length && !current,
  };
}

function useBalances(address: string, market: Market) {
  const { revision } = useLive();
  const key = `${address}:${market.pool}:${revision}`;
  const [read, setRead] = useState<
    { key: string; balances: { base: bigint; quote: bigint } | null } | null
  >(null);
  useEffect(() => {
    if (!address) return;
    let active = true;
    readTradingWallet(address, market).then(
      (b) => active && setRead({ key, balances: { base: BigInt(b.base), quote: BigInt(b.quote) } }),
      () => active && setRead({ key, balances: null }),
    );
    return () => {
      active = false;
    };
  }, [address, market, key]);
  const current = read?.key === key ? read : null;
  return { balances: current?.balances ?? null, failed: !!current && !current.balances };
}

// The stock amount that matches the typed token amount, from the SDK's quote.
function useDepositQuote(pool: GraduatedPool, amount: string) {
  let raw: bigint | null = null,
    invalid = "";
  if (amount.trim())
    try {
      raw = parseUnits(amount.trim(), pool.market.baseDecimals);
    } catch (e) {
      invalid = message(e, "Enter an amount.");
    }
  const key = raw === null ? "" : `${pool.address}:${pool.slot}:${raw}`;
  const [read, setRead] = useState<{ key: string; b?: bigint; error?: string } | null>(null);
  useEffect(() => {
    if (raw === null) return;
    let active = true;
    quoteDeposit(pool, raw).then(
      (q) => active && setRead({ key, b: q.b }),
      (e) => active && setRead({ key, error: message(e, "Quote unavailable.") }),
    );
    return () => {
      active = false;
    };
  }, [key, pool, raw]);
  const current = read?.key === key ? read : null;
  const tooSmall = current?.b === 0n ? "Amount is too small." : undefined;
  return { raw, b: current?.b, error: invalid || current?.error || tooSmall, loading: raw !== null && !current };
}

function PairLabel({
  market,
  quote,
  profile,
  size,
}: {
  market: Market;
  quote: string;
  profile: TokenProfile | null;
  size: number;
}) {
  return (
    <span className="pool-pair">
      {profile?.image ? (
        <>
          <TokenImage profile={profile} symbol={market.symbol} size={size} />
          <b>{market.symbol}</b>
        </>
      ) : (
        <TokenName symbol={market.symbol} size={size} />
      )}
      <span className="sr-pair-divider">/</span>
      <TokenName symbol={quote} size={Math.round(size * 0.8)} />
    </span>
  );
}

function PoolCard({
  pool,
  selected,
  mine,
  onSelect,
}: {
  pool: GraduatedPool;
  selected: boolean;
  mine: boolean;
  onSelect: () => void;
}) {
  const m = pool.market;
  const profile = useTokenProfile(m.uri);
  const lpFarm = isLpFarm(m, profile?.feeModel);
  return (
    <div className="pool-card" data-selected={selected} role="listitem">
      <button type="button" className="pool-card-select" aria-pressed={selected} onClick={onSelect}>
        <PairLabel market={m} quote={pool.quoteSymbol} profile={profile} size={28} />
        <span className="pool-stats">
          <span>
            <small>Liquidity</small>
            <strong>
              {displayAmount(pool.value, m.quoteDecimals)} {pool.quoteSymbol}
            </strong>
          </span>
          <span>
            <small>Fee</small>
            <strong>{percent(pool.feeBps)}</strong>
          </span>
        </span>
        {(lpFarm || mine || pool.reserve) && (
          <span className="pool-tags">
            {pool.reserve && <span className="pool-tag">Creator reserve pool · fees compound</span>}
            {lpFarm && (
              <span className="pool-tag" data-tone="farm">
                <Sprout size={12} aria-hidden /> Pays LP Farm rewards
              </span>
            )}
            {mine && (
              <span className="pool-tag" data-tone="mine">
                Your position
              </span>
            )}
          </span>
        )}
      </button>
      <div className="pool-card-foot">
        <MarketBadges market={m} data={pool.badges} feeModel={profile?.feeModel} quote={pool.quoteSymbol} />
        <Link href={marketHref(m)}>Market</Link>
        <a href={meteoraPool(pool.address)} target="_blank" rel="noreferrer">
          Meteora <ArrowUpRight size={12} />
        </a>
        <a href={explorer("address", pool.address)} target="_blank" rel="noreferrer">
          Explorer <ArrowUpRight size={12} />
        </a>
      </div>
    </div>
  );
}

function AddLiquidity({ pool }: { pool: GraduatedPool }) {
  const { address, busy, pending, execute } = useLive();
  const m = pool.market,
    q = pool.quoteSymbol;
  const [amount, setAmount] = useState("");
  const [maxError, setMaxError] = useState("");
  const quote = useDepositQuote(pool, amount);
  const { balances, failed } = useBalances(address, m);
  const limits =
    quote.raw && quote.b && balances
      ? depositLimits(quote.raw, quote.b, balances.base, balances.quote)
      : null;
  const shortfall =
    limits?.short === "base"
      ? `Not enough ${m.symbol}: you need ${displayAmount(limits.maxA, m.baseDecimals)}, including a 0.5% buffer.`
      : limits?.short === "quote"
        ? `Not enough ${q}: you need ${displayAmount(limits.maxB, m.quoteDecimals)}, including a 0.5% buffer.`
        : "";
  const enabled = !!address && !busy && !pending && !!quote.b && !shortfall;
  async function fillMax() {
    if (!balances) return;
    setMaxError("");
    try {
      const raw = await maxDeposit(pool, balances.base, balances.quote);
      if (raw > 0n) setAmount(formatUnits(raw, m.baseDecimals));
      else setMaxError(`Add ${m.symbol} and ${q} to your wallet first.`);
    } catch (e) {
      setMaxError(message(e, "Could not size the deposit."));
    }
  }
  return (
    <Card className="sr-panel pool-add">
      <h3>Add liquidity</h3>
      <Label htmlFor="pool-amount">{m.symbol} to add</Label>
      <div className="pool-amount">
        <Input
          id="pool-amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.0"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setMaxError("");
          }}
        />
        {address && (
          <Button type="button" variant="outline" disabled={!balances} onClick={() => void fillMax()}>
            Max
          </Button>
        )}
      </div>
      <div className="sr-detail-row">
        <span>{q} to add</span>
        <strong>
          {quote.b !== undefined ? `${displayAmount(quote.b, m.quoteDecimals)} ${q}` : quote.loading ? "…" : "—"}
        </strong>
      </div>
      {address && (
        <div className="sr-detail-row">
          <span>In your wallet</span>
          <strong>
            {balances
              ? `${displayAmount(balances.base, m.baseDecimals)} ${m.symbol} · ${displayAmount(balances.quote, m.quoteDecimals)} ${q}`
              : failed
                ? "Unavailable. Refresh to retry."
                : "Reading…"}
          </strong>
        </div>
      )}
      {(quote.error || shortfall || maxError) && (
        <p className="sr-note text-destructive" role="status">
          {quote.error || shortfall || maxError}
        </p>
      )}
      {address ? (
        <Button
          className="w-full"
          disabled={!enabled}
          onClick={() => void execute(() => preparePoolDeposit(address, pool, amount.trim()))}
        >
          Review deposit
        </Button>
      ) : (
        <WalletConnectButton />
      )}
      <p className="sr-note">
        Adds both tokens at the pool price. You get a position NFT and can withdraw any time. Prices
        move, so fees don&apos;t guarantee a profit.
      </p>
    </Card>
  );
}

const WITHDRAW_STEPS = [2500, 5000, 10_000];

function PositionItem({ pool, position: p }: { pool: GraduatedPool; position: PoolPosition }) {
  const { address, busy, pending, execute } = useLive();
  const [bps, setBps] = useState(10_000);
  const m = pool.market,
    q = pool.quoteSymbol;
  const enabled = !!address && !busy && !pending;
  const hasFees = p.feeA > 0n || p.feeB > 0n;
  return (
    <div className="pool-position">
      <div className="pool-position-head">
        <a className="sr-text-link" href={explorer("address", p.address)} target="_blank" rel="noreferrer">
          Position {short(p.address)} <ArrowUpRight size={12} />
        </a>
        <span>{p.share} of pool</span>
      </div>
      {p.unlocked > 0n && (
        <div className="sr-detail-row">
          <span>Withdrawable</span>
          <strong>
            {displayAmount(p.a, m.baseDecimals)} {m.symbol}
            <br />
            {displayAmount(p.b, m.quoteDecimals)} {q}
          </strong>
        </div>
      )}
      {p.locked > 0n && (
        <div className="sr-detail-row">
          <span>
            <Lock size={12} aria-hidden /> Locked
          </span>
          <strong>{p.unlocked > 0n ? "Part of this position" : "All of it"}: earns fees, can&apos;t be withdrawn</strong>
        </div>
      )}
      {pool.lpFeePercent > 0 && (
      <div className="sr-detail-row">
        <span>Unclaimed stock fees</span>
        <strong>
          {hasFees ? (
            <>
              {displayAmount(p.feeB, m.quoteDecimals)} {q}
              {p.feeA > 0n && (
                <>
                  <br />
                  {displayAmount(p.feeA, m.baseDecimals)} {m.symbol}
                </>
              )}
            </>
          ) : (
            "None yet"
          )}
        </strong>
      </div>
      )}
      <div className="pool-position-actions">
        {p.unlocked > 0n && (
          <>
            <div className="segmented" role="radiogroup" aria-label="Amount to withdraw">
              {WITHDRAW_STEPS.map((step) => (
                <button type="button" role="radio" key={step} aria-checked={bps === step} onClick={() => setBps(step)}>
                  {step === 10_000 ? "All" : `${step / 100}%`}
                </button>
              ))}
            </div>
            <Button
              variant="outline"
              disabled={!enabled}
              onClick={() => void execute(() => preparePoolWithdrawal(address, pool, p, bps))}
            >
              Withdraw
            </Button>
          </>
        )}
        {pool.lpFeePercent > 0 && (
          <Button
            variant="outline"
            disabled={!enabled || !hasFees}
            onClick={() => void execute(() => preparePoolClaim(address, pool, p))}
          >
            Claim fees
          </Button>
        )}
      </div>
    </div>
  );
}

function Positions({
  pool,
  positions,
  loading,
  error,
  lpFarm,
}: {
  pool: GraduatedPool;
  positions: PoolPosition[];
  loading: boolean;
  error?: string;
  lpFarm: boolean;
}) {
  const { address } = useLive();
  return (
    <Card className="sr-panel pool-positions">
      <h3>Your positions</h3>
      {!address ? (
        <>
          <p className="sr-note">Connect a wallet to see your positions.</p>
          <WalletConnectButton />
        </>
      ) : error ? (
        <p className="sr-note text-destructive">{error}</p>
      ) : loading ? (
        <p className="sr-note">Reading your positions…</p>
      ) : !positions.length ? (
        <p className="sr-note">No positions in this pool yet.</p>
      ) : (
        positions.map((p) => <PositionItem key={p.address} pool={pool} position={p} />)
      )}
      <p className="sr-note">
        {pool.lpFeePercent > 0
          ? "Withdrawing doesn't claim fees; claim them separately."
          : "Fees are added back into the pool, so withdrawing includes them."}
        {lpFarm && " LP Farm rewards go to unlocked liquidity."}
      </p>
    </Card>
  );
}

function PoolDetail({
  pool,
  positions,
  detail,
}: {
  pool: GraduatedPool;
  positions: ReturnType<typeof usePositions>;
  detail: RefObject<HTMLElement | null>;
}) {
  const m = pool.market,
    q = pool.quoteSymbol;
  const profile = useTokenProfile(m.uri);
  const lpFarm = isLpFarm(m, profile?.feeModel);
  // The reserve pool trades apart from its market's curve, so the two prices can drift.
  const gap = pool.curveSqrtPrice ? priceRatioBps(BigInt(pool.state.sqrtPrice.toString()), pool.curveSqrtPrice) : null;
  const drifted = gap !== null && Math.abs(gap - 10_000) > RESERVE_PRICE_GAP_BPS;
  return (
    <section className="pool-detail" ref={detail} aria-labelledby="pool-detail-title">
      <div className="sr-section-top pool-detail-top">
        <div>
          <span className="sr-eyebrow">
            <MeteoraLabel>Meteora DAMM v2</MeteoraLabel>
          </span>
          <h2 id="pool-detail-title">
            <PairLabel market={m} quote={q} profile={profile} size={30} />
          </h2>
        </div>
        <div className="pool-links">
          {lpFarm && (
            <span className="pool-tag" data-tone="farm">
              <Sprout size={12} aria-hidden /> Pays LP Farm rewards
            </span>
          )}
          <Link className="sr-text-link" href={marketHref(m)}>
            Market <ArrowUpRight size={13} />
          </Link>
          <a className="sr-text-link" href={meteoraPool(pool.address)} target="_blank" rel="noreferrer">
            Meteora <ArrowUpRight size={13} />
          </a>
          <a className="sr-text-link" href={explorer("address", pool.address)} target="_blank" rel="noreferrer">
            Explorer <ArrowUpRight size={13} />
          </a>
        </div>
      </div>
      <Card className="sr-panel pool-facts">
        <div className="sr-detail-row">
          <span>In the pool</span>
          <strong>
            {displayAmount(pool.tokenA, m.baseDecimals)} {m.symbol} + {displayAmount(pool.tokenB, m.quoteDecimals)} {q}
          </strong>
        </div>
        <div className="sr-detail-row">
          <span>Trading fee</span>
          <strong>
            {percent(pool.feeBps)}
            {pool.dynamicFee ? ", more on fast moves" : ""}
          </strong>
        </div>
        <div className="sr-detail-row">
          <span>To liquidity providers</span>
          <strong>
            {pool.compoundPercent > 0
              ? `${Number(pool.compoundPercent.toFixed(2))}% of each fee, added back into the pool`
              : `${Number(pool.lpFeePercent.toFixed(2))}% of each fee${pool.collectFeeMode === 1 ? `, paid in ${q}` : ""}`}
          </strong>
        </div>
        {pool.reserve && (
          <div className="sr-detail-row">
            <span>About this pool</span>
            <strong>
              Creators of mSPY markets can put their creator reserve here from the Treasury page; anyone can add too
            </strong>
          </div>
        )}
        {gap !== null && (
          <div className="sr-detail-row">
            <span>Pool price</span>
            <strong>
              {Number((gap / 100).toFixed(1))}% of {m.symbol}&apos;s price on its bonding curve
            </strong>
          </div>
        )}
        {lpFarm && (
          <div className="sr-detail-row">
            <span>LP Farm</span>
            <strong>Also pays this pool&apos;s LPs from the token&apos;s fee share, by unlocked liquidity</strong>
          </div>
        )}
      </Card>
      {drifted && (
        <Alert className="mb-4">
          <AlertDescription>
            {`This pool prices ${m.symbol} ${gap! < 10_000 ? "below" : "above"} its bonding curve (${Number((gap! / 100).toFixed(1))}%). Adding liquidity here puts your ${m.symbol} in at the pool's price, and trades between the two can move value out of the pool.`}
          </AlertDescription>
        </Alert>
      )}
      <div className="pool-detail-grid">
        <AddLiquidity key={pool.address} pool={pool} />
        <Positions
          pool={pool}
          positions={positions.positions?.get(pool.address) ?? []}
          loading={positions.loading}
          error={positions.error}
          lpFarm={lpFarm}
        />
      </div>
    </section>
  );
}

type Network = "mainnet" | "devnet";
const NETWORKS = [
  ["devnet", "Devnet (our demo)"],
  ["mainnet", "Mainnet"],
] as const;

export function LiquidityWorkspace() {
  const { address } = useLive();
  const { list, error, loading, refresh } = usePoolList();
  const positions = usePositions(address, list);
  const params = useSearchParams();
  const wanted = params.get("pool");
  // Opens on Devnet, where Sonata's own pools are; ?net=mainnet opens the live Mainnet list.
  const [network, setNetwork] = useState<Network>(() =>
    !wanted && params.get("net") === "mainnet" ? "mainnet" : "devnet",
  );
  const mainnet = useMainnetPools(network === "mainnet");
  // The tab is kept in the address, so a reload or a shared link opens the same one.
  function pickNetwork(next: Network) {
    setNetwork(next);
    const url = new URL(window.location.href);
    if (next === "devnet") url.searchParams.delete("net");
    else {
      url.searchParams.set("net", "mainnet");
      url.searchParams.delete("pool");
    }
    window.history.replaceState(window.history.state, "", url);
  }
  const [picked, setPicked] = useState<string | null>(null);
  const detail = useRef<HTMLElement>(null);
  const pools = list?.pools ?? [];
  // ?pool= takes the DAMM v2 pool or the market's own pool address.
  const selected =
    pools.find((p) => p.address === picked) ??
    pools.find((p) => p.address === wanted || p.market.pool === wanted) ??
    pools[0];
  function choose(pool: GraduatedPool) {
    setPicked(pool.address);
    // On a phone the pool's panel is below the list: bring it into view.
    if (window.matchMedia("(max-width: 900px)").matches)
      requestAnimationFrame(() => detail.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  const reading = network === "mainnet" ? mainnet.loading : loading;
  return (
    <>
      <div className="sr-heading">
        <div>
          <span className="sr-eyebrow">SONATA / EARN</span>
          <h1>Pools</h1>
          <p>
            {network === "mainnet"
              ? "Put your stocks to work: add them to a live Meteora pool on Solana mainnet and earn its trading fees."
              : "Add liquidity to a Sonata token's Meteora pool and earn its trading fees. LP Farm tokens also pay their LPs."}
          </p>
        </div>
        <Button variant="outline" disabled={reading} onClick={network === "mainnet" ? mainnet.refresh : refresh}>
          <RefreshCw className={reading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>
      <div className="segmented pool-network" role="radiogroup" aria-label="Network">
        {NETWORKS.map(([key, title]) => (
          <button type="button" role="radio" key={key} aria-checked={network === key} onClick={() => pickNetwork(key)}>
            {title}
          </button>
        ))}
      </div>
      {network === "mainnet" ? (
        <MainnetPools {...mainnet} />
      ) : (
        <DevnetPools
          list={list}
          error={error}
          loading={loading}
          pools={pools}
          selected={selected}
          positions={positions}
          detail={detail}
          choose={choose}
          wanted={wanted}
        />
      )}
    </>
  );
}

// Sonata's own graduated pools on Devnet: add liquidity, withdraw and claim here.
function DevnetPools({
  list,
  error,
  loading,
  pools,
  selected,
  positions,
  detail,
  choose,
  wanted,
}: {
  wanted: string | null;
  list?: PoolList;
  error?: string;
  loading: boolean;
  pools: GraduatedPool[];
  selected?: GraduatedPool;
  positions: ReturnType<typeof usePositions>;
  detail: RefObject<HTMLElement | null>;
  choose: (pool: GraduatedPool) => void;
}) {
  // A link to one pool (?pool=) that is not listed says so, with the check it failed.
  const missing =
    wanted && list && !pools.some((p) => p.address === wanted || p.market.pool === wanted)
      ? { reason: list.skipped.find((s) => s.pool === wanted || s.market.pool === wanted)?.reason }
      : null;
  return (
    <>
      <LiveWallet />
      {error && (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!list ? (
        loading && <p className="sr-note">Reading Sonata pools…</p>
      ) : !pools.length ? (
        <Card className="sr-panel pools-empty">
          <Sprout size={24} aria-hidden />
          <h3>No pools yet</h3>
          <p className="sr-note">
            {"A token's pool shows up here once it completes its bonding curve."}
          </p>
          <Button asChild variant="outline">
            <Link href="/">
              Browse markets <ArrowUpRight />
            </Link>
          </Button>
        </Card>
      ) : (
        <>
          {missing && (
            <Alert className="mb-4">
              <AlertDescription>
                {missing.reason
                  ? `The pool you opened isn't offered: ${missing.reason} Showing the others.`
                  : "The pool you opened isn't listed right now. Showing the others."}
              </AlertDescription>
            </Alert>
          )}
          <div className="pool-list" role="list" aria-label="Sonata pools">
            {pools.map((p) => (
              <PoolCard
                key={p.address}
                pool={p}
                selected={p === selected}
                mine={!!positions.positions?.get(p.address)?.length}
                onSelect={() => choose(p)}
              />
            ))}
          </div>
          {selected && <PoolDetail pool={selected} positions={positions} detail={detail} />}
        </>
      )}
      {!!list?.skipped.length && (
        <p className="sr-note">
          Hidden after failing a check:{" "}
          {list.skipped.map((s) => `${s.market.symbol} (${s.reason})`).join(", ")}
        </p>
      )}
    </>
  );
}
