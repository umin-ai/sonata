"use client";
import { useEffect, useState, type CSSProperties } from "react";
import { ArrowUpRight, Globe, Percent, ShieldAlert, Sprout } from "lucide-react";
import { TokenFallback, TokenName } from "@/app/token-identity";

const TOKEN_LIST = "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet";
const KNOWN_LOGOS: Record<string, string> = {
  So11111111111111111111111111111111111111112: `${TOKEN_LIST}/So11111111111111111111111111111111111111112/logo.png`,
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: `${TOKEN_LIST}/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png`,
};
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import {
  KIND_LABEL,
  MAINNET_STOCKS,
  MIN_POOL_TVL_USD,
  compactUsd,
  mainnetExplorer,
  meteoraPoolUrl,
  percentText,
  type MainnetPool,
  type MainnetStock,
  type PoolToken,
  type TransferFee,
} from "@/lib/liquidity/mainnet-pools";
import { STOCK_FAMILIES, type StockFamily } from "@/lib/pricing/stock-price";

type Payload = {
  pools: MainnetPool[];
  stocks: MainnetStock[];
  updatedAt: number;
  missing: string[];
  flagged: number;
  transferFees: Record<string, TransferFee>;
  stale?: boolean;
};

const POLL_MS = 60_000;
// Stock chips shown before "+N more".
const CHIP_LIMIT = 12;

// Meteora's live pools: read on load, on Refresh, and every minute while the
// Mainnet tab is open and visible (the server reads Meteora at most once a
// minute). The last list stays on screen while a new one loads.
export function useMainnetPools(active: boolean) {
  const [nonce, setNonce] = useState(0);
  const [read, setRead] = useState<{
    nonce: number;
    data?: Payload;
    receivedAt?: number;
    error?: string;
  } | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/mainnet-pools")
      .then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as { pools?: unknown; error?: string };
        if (!r.ok || !Array.isArray(body.pools))
          throw Error(body.error ?? "Meteora's pool data is unavailable right now.");
        return body as unknown as Payload;
      })
      .then(
        (data) => live && setRead({ nonce, data, receivedAt: Date.now() }),
        (e) =>
          live &&
          setRead((last) => ({
            nonce,
            data: last?.data,
            receivedAt: last?.receivedAt,
            error: e instanceof Error ? e.message : "Pools unavailable.",
          })),
      );
    return () => {
      live = false;
    };
  }, [nonce]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setNonce((n) => n + 1);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active]);
  return {
    data: read?.data,
    receivedAt: read?.receivedAt,
    error: read?.nonce === nonce ? read.error : undefined,
    loading: read?.nonce !== nonce,
    refresh: () => setNonce((n) => n + 1),
  };
}

// A stock shows its issuer's logo; any other token a monogram, so a look-alike
// never borrows a stock's logo.
function Token({ token, size, stock }: { token: PoolToken; size: number; stock?: MainnetStock }) {
  if (token.stock && stock?.logo)
    return (
      <span className="sr-token-name" style={{ "--token-size": `${size}px` } as CSSProperties}>
        {/* eslint-disable-next-line @next/next/no-img-element -- Backed's logo, from its own CDN */}
        <img src={stock.logo} width={size} height={size} alt="" className="sr-token-logo" />
        <b>{token.symbol}</b>
      </span>
    );
  if (token.stock) return <TokenName symbol={token.symbol} size={size} />;
  // SOL and USDC by mint; any other token gets the "?" badge.
  const known = KNOWN_LOGOS[token.mint];
  return (
    <span className="sr-token-name" style={{ "--token-size": `${size}px` } as CSSProperties}>
      {known ? (
        // eslint-disable-next-line @next/next/no-img-element -- the Solana token list's logo
        <img src={known} width={size} height={size} alt="" className="sr-token-logo" />
      ) : (
        <TokenFallback size={size} />
      )}
      <b>{token.symbol}</b>
    </span>
  );
}

const feeText = (symbol: string, fee: TransferFee) =>
  `${symbol}: ${percentText(fee.bps / 100)} fee on every transfer` +
  (fee.next ? `, ${percentText(fee.next.bps / 100)} in about ${fee.next.inDays} day${fee.next.inDays === 1 ? "" : "s"}` : "");

function MainnetPoolCard({
  pool,
  fees,
  stocks,
}: {
  pool: MainnetPool;
  fees: Record<string, TransferFee>;
  stocks: Map<string, MainnetStock>;
}) {
  const other = [pool.x, pool.y].find((t) => !t.verified);
  const taxed = pool.stocks.filter((s) => fees[s]);
  const halted = pool.stockMints.flatMap((m) => (stocks.get(m)?.halted ? [stocks.get(m)!.symbol] : []));
  return (
    <div className="pool-card" role="listitem">
      <div className="pool-card-main">
        <span className="pool-pair">
          <Token token={pool.x} size={26} stock={stocks.get(pool.x.mint)} />
          <span className="sr-pair-divider">/</span>
          <Token token={pool.y} size={22} stock={stocks.get(pool.y.mint)} />
        </span>
        <span className="pool-stats">
          <span>
            <small>Liquidity</small>
            <strong>{compactUsd(pool.tvl)}</strong>
          </span>
          <span>
            <small>Fee</small>
            <strong>{percentText(pool.feePct)}</strong>
          </span>
          <span>
            <small>LP fees, 24h</small>
            <strong>{compactUsd(pool.lpFees24h)}</strong>
          </span>
          <span>
            <small>24h LP fees / liquidity</small>
            <strong>{percentText(pool.lpFeeTvl24h)}</strong>
          </span>
        </span>
        <span className="pool-tags">
          <span className="pool-tag">{KIND_LABEL[pool.kind]}</span>
          {other && (
            <span className="pool-tag" data-tone="warn">
              <ShieldAlert size={12} aria-hidden /> {other.symbol} is unverified
            </span>
          )}
          {halted.map((s) => (
            <span className="pool-tag" data-tone="warn" key={`halted-${s}`}>
              <ShieldAlert size={12} aria-hidden /> {s}: trading halted by Backed
            </span>
          ))}
          {taxed.map((s) => (
            <span className="pool-tag" data-tone="warn" key={s}>
              <Percent size={12} aria-hidden /> {feeText(s, fees[s])}
            </span>
          ))}
        </span>
      </div>
      <div className="pool-card-foot">
        <a href={meteoraPoolUrl(pool)} target="_blank" rel="noreferrer">
          Add liquidity on Meteora <ArrowUpRight size={12} />
        </a>
        <a href={mainnetExplorer(pool.address)} target="_blank" rel="noreferrer">
          Explorer <ArrowUpRight size={12} />
        </a>
      </div>
    </div>
  );
}

function asOf(ms: number, receivedAt?: number) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return receivedAt && receivedAt - ms > 12 * 3_600_000
    ? `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`
    : time;
}

export function MainnetPools({ data, receivedAt, error, loading }: ReturnType<typeof useMainnetPools>) {
  const [family, setFamily] = useState<StockFamily>("xStocks");
  const [picked, setPicked] = useState<string | null>(null);
  const [showUnverified, setShowUnverified] = useState(false);
  const [allStocks, setAllStocks] = useState(false);
  const all = data?.pools ?? [];
  const byMint = new Map((data?.stocks ?? []).map((s) => [s.mint, s]));
  const fees = data?.transferFees ?? {};
  // Pools whose other token is unverified are mostly that token, priced by the pool itself.
  const pools = showUnverified ? all : all.filter((p) => !p.unverified);
  const inFamily = pools.filter((p) => p.families.includes(family));
  // One chip per stock with pools here, largest liquidity first.
  const stocks = (data?.stocks ?? [])
    .filter((s) => s.family === family)
    .map((s) => {
      const held = inFamily.filter((p) => p.stockMints.includes(s.mint));
      return { symbol: s.symbol, count: held.length, tvl: held.reduce((sum, p) => sum + p.tvl, 0) };
    })
    .filter((s) => s.count)
    .sort((a, b) => b.tvl - a.tvl);
  // Collapsed, the picked stock's chip still shows, so the filter in use is always visible.
  const top = stocks.slice(0, CHIP_LIMIT);
  const pickedChip = stocks.find((s) => s.symbol === picked);
  const chips = allStocks || !pickedChip || top.includes(pickedChip) ? (allStocks ? stocks : top) : [...top, pickedChip];
  // A stock whose pools left the list (after a refresh or a filter) falls back to All.
  const stock = picked && stocks.some((s) => s.symbol === picked) ? picked : null;
  const shown = stock ? inFamily.filter((p) => p.stocks.includes(stock)) : inFamily;
  const tvl = shown.reduce((sum, p) => sum + p.tvl, 0),
    lpFees = shown.reduce((sum, p) => sum + p.lpFees24h, 0);
  // Unverified pairs in the current view: the family, or the picked stock.
  const unverifiedHere = all.filter(
    (p) => p.unverified && p.families.includes(family) && (!stock || p.stocks.includes(stock)),
  ).length;
  // Every stock a query covers: the PreStocks by name, the xStocks with pools.
  const familySymbols = new Set([
    ...MAINNET_STOCKS.filter((s) => s.family === family).map((s) => s.symbol),
    ...(data?.stocks ?? []).filter((s) => s.family === family).map((s) => s.symbol),
  ]);
  const familyMissing = !!data?.missing.some(
    (m) =>
      familySymbols.has(m.split(" ")[0]) ||
      (family === "xStocks" && (m.startsWith("xStocks ") || m === "the full xStock list")),
  );
  return (
    <>
      <Alert className="mb-4 pool-mainnet-note">
        <Globe aria-hidden />
        <AlertDescription>
          Real pools on Solana mainnet, with real funds. Sonata lists them from Meteora; you add liquidity on Meteora,
          with your own wallet.
        </AlertDescription>
      </Alert>
      {error && (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!data ? (
        loading && <p className="sr-note">Reading Meteora pools on mainnet…</p>
      ) : (
        <>
          <div className="pair-tabs" role="tablist" aria-label="Stock family">
            {STOCK_FAMILIES.map((f) => (
              <button
                type="button"
                role="tab"
                key={f}
                aria-selected={family === f}
                onClick={() => {
                  setFamily(f);
                  setPicked(null);
                }}
              >
                {f}
                <span>{pools.filter((p) => p.families.includes(f)).length}</span>
              </button>
            ))}
          </div>
          {!!stocks.length && (
            <div className="pool-chips" role="radiogroup" aria-label="Stock">
              {[{ symbol: null, count: inFamily.length }, ...chips].map((s) => (
                <button
                  type="button"
                  role="radio"
                  key={s.symbol ?? "all"}
                  aria-checked={stock === s.symbol}
                  onClick={() => setPicked(s.symbol)}
                >
                  {s.symbol ?? "All"} <span>{s.count}</span>
                </button>
              ))}
              {stocks.length > CHIP_LIMIT && (
                <button type="button" className="pool-chips-more" onClick={() => setAllStocks((v) => !v)}>
                  {allStocks ? "Fewer" : `+${stocks.length - CHIP_LIMIT} more`}
                </button>
              )}
            </div>
          )}
          {family === "PreStocks" && (
            <p className="sr-note">
              PreStocks tokens take a fee on every transfer, including when you add or remove liquidity.
            </p>
          )}
          {shown.length ? (
            <>
              <p className="pool-summary">
                <strong>{shown.length}</strong> pool{shown.length === 1 ? "" : "s"} ·{" "}
                <strong>{compactUsd(tvl)}</strong> liquidity · <strong>{compactUsd(lpFees)}</strong> paid to LPs in
                the last 24h
              </p>
              <div className="pool-list" role="list" aria-label="Mainnet pools">
                {shown.map((p) => (
                  <MainnetPoolCard key={p.address} pool={p} fees={fees} stocks={byMint} />
                ))}
              </div>
            </>
          ) : (
            <Card className="sr-panel pools-empty">
              <Sprout size={24} aria-hidden />
              <h3>{familyMissing ? `Couldn't read every ${family} pool` : `No ${family} pools right now`}</h3>
              <p className="sr-note">
                {familyMissing
                  ? "Meteora didn't answer for some of them. Try Refresh in a minute."
                  : `Meteora lists none above ${compactUsd(MIN_POOL_TVL_USD)} of liquidity.`}
              </p>
            </Card>
          )}
          {(!!unverifiedHere || showUnverified) && (
            <label className="pool-toggle">
              <input type="checkbox" checked={showUnverified} onChange={(e) => setShowUnverified(e.target.checked)} />
              {showUnverified ? "Showing" : "Show"} {unverifiedHere} pair{unverifiedHere === 1 ? "" : "s"} with an
              unverified token. Most of their liquidity is that token, priced by the pool itself.
            </label>
          )}
          <p className="sr-note">
            Live from Meteora, as of {asOf(data.updatedAt, receivedAt)}
            {data.stale ? " (Meteora didn't answer the last read)" : ", updated every minute"}. LP fees are after
            Meteora&apos;s protocol share. Hidden: pools under {compactUsd(MIN_POOL_TVL_USD)} of liquidity
            {data.flagged ? `, and ${data.flagged} flagged by Meteora` : ""}.
            {!!data.missing.length && ` Couldn't read: ${data.missing.join(", ")}.`} Prices move, so fees don&apos;t
            guarantee a profit.
          </p>
        </>
      )}
    </>
  );
}
