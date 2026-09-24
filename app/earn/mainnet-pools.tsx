"use client";
import { useEffect, useState, type CSSProperties } from "react";
import { ArrowUpRight, Globe, Percent, ShieldAlert, Sprout } from "lucide-react";
import { TokenName } from "@/app/token-identity";
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
  type PoolToken,
  type TransferFee,
} from "@/lib/liquidity/mainnet-pools";
import { STOCK_FAMILIES, type StockFamily } from "@/lib/pricing/stock-price";

type Payload = {
  pools: MainnetPool[];
  updatedAt: number;
  missing: string[];
  flagged: number;
  transferFees: Record<string, TransferFee>;
  stale?: boolean;
};

const POLL_MS = 60_000;

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

// A stock shows its own logo; any other token a monogram, so a look-alike never
// borrows a stock's logo.
function Token({ token, size }: { token: PoolToken; size: number }) {
  if (token.stock) return <TokenName symbol={token.symbol} size={size} />;
  return (
    <span className="sr-token-name" style={{ "--token-size": `${size}px` } as CSSProperties}>
      <span className="sr-token-monogram" aria-hidden="true">
        {token.symbol.slice(0, 2)}
      </span>
      <b>{token.symbol}</b>
    </span>
  );
}

const feeText = (symbol: string, fee: TransferFee) =>
  `${symbol}: ${percentText(fee.bps / 100)} fee on every transfer` +
  (fee.next ? `, ${percentText(fee.next.bps / 100)} in about ${fee.next.inDays} day${fee.next.inDays === 1 ? "" : "s"}` : "");

function MainnetPoolCard({ pool, fees }: { pool: MainnetPool; fees: Record<string, TransferFee> }) {
  const other = [pool.x, pool.y].find((t) => !t.verified);
  const taxed = pool.stocks.filter((s) => fees[s]);
  return (
    <div className="pool-card" role="listitem">
      <div className="pool-card-main">
        <span className="pool-pair">
          <Token token={pool.x} size={26} />
          <span className="sr-pair-divider">/</span>
          <Token token={pool.y} size={22} />
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
  const all = data?.pools ?? [];
  const fees = data?.transferFees ?? {};
  // Pools whose other token is unverified are mostly that token, priced by the pool itself.
  const pools = showUnverified ? all : all.filter((p) => !p.unverified);
  const inFamily = pools.filter((p) => p.families.includes(family));
  const stocks = MAINNET_STOCKS.filter((s) => s.family === family)
    .map((s) => ({ symbol: s.symbol, count: inFamily.filter((p) => p.stocks.includes(s.symbol)).length }))
    .filter((s) => s.count);
  // A stock whose pools left the list (after a refresh or a filter) falls back to All.
  const stock = picked && stocks.some((s) => s.symbol === picked) ? picked : null;
  const shown = stock ? inFamily.filter((p) => p.stocks.includes(stock)) : inFamily;
  const tvl = shown.reduce((sum, p) => sum + p.tvl, 0),
    lpFees = shown.reduce((sum, p) => sum + p.lpFees24h, 0);
  const hiddenUnverified = all.filter((p) => p.unverified && p.families.includes(family)).length;
  const familySymbols = new Set(MAINNET_STOCKS.filter((s) => s.family === family).map((s) => s.symbol));
  const familyMissing = !!data?.missing.some((m) => familySymbols.has(m.split(" ")[0]));
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
              {[{ symbol: null, count: inFamily.length }, ...stocks].map((s) => (
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
                  <MainnetPoolCard key={p.address} pool={p} fees={fees} />
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
          {!!hiddenUnverified && (
            <label className="pool-toggle">
              <input type="checkbox" checked={showUnverified} onChange={(e) => setShowUnverified(e.target.checked)} />
              Show {hiddenUnverified} pair{hiddenUnverified === 1 ? "" : "s"} with an unverified token. Most of their
              liquidity is that token, priced by the pool itself.
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
