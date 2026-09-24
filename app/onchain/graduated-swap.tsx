"use client";
import { useEffect, useState, type ReactNode } from "react";
import { listGraduatedPools, preparePoolSwap, quotePoolSwap, type GraduatedPool } from "@/lib/liquidity/pools";
import type { Market } from "@/lib/treasury/runtime";
import { parseUnits } from "@/lib/treasury/units";
import { useLive } from "./live-session";
import { SwapPanel } from "./swap-panel";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

// The market's graduated DAMM v2 pool, checked as the Pools page checks it,
// re-read after each confirmed transaction. The last read stays while a new one loads.
function useGraduatedPool(market: Market) {
  const { revision } = useLive();
  const key = `${market.pool}:${revision}`;
  const [read, setRead] = useState<{ key: string; pool: GraduatedPool | null; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    listGraduatedPools([market]).then(
      (list) => {
        const pool = list.pools.find((p) => !p.reserve && p.market.pool === market.pool) ?? null;
        const skipped = list.skipped.find((s) => s.market.pool === market.pool && s.pool !== undefined);
        if (active) setRead({ key, pool, error: pool ? undefined : (skipped?.reason ?? "Pool not found.") });
      },
      (e) => active && setRead((last) => ({ key, pool: last?.pool ?? null, error: message(e, "Pool unavailable.") })),
    );
    return () => {
      active = false;
    };
  }, [key, market]);
  return { pool: read?.pool ?? null, error: read?.error, loading: !read };
}

/** Buy and sell a graduated token in its Meteora pool, in the stock. */
export function GraduatedSwap({
  market,
  quote: q,
  balances,
  baseToken,
}: {
  market: Market;
  quote: string;
  balances: { base: string; quote: string } | null;
  baseToken: ReactNode;
}) {
  const { address } = useLive();
  const { pool, error, loading } = useGraduatedPool(market);
  return (
    <SwapPanel
      market={market}
      quoteSymbol={q}
      balances={balances}
      baseToken={baseToken}
      route="Meteora DAMM v2 pool"
      fee={pool ? { bps: pool.feeBps, dynamic: pool.dynamicFee } : undefined}
      unavailable={pool ? undefined : loading ? "Reading the pool…" : `The pool can't be traded here right now: ${error}`}
      quote={async (side, amount) => {
        if (!pool) throw Error("Reading the pool…");
        const raw = parseUnits(amount, side === "buy" ? market.quoteDecimals : market.baseDecimals);
        const result = await quotePoolSwap(pool, side, raw);
        return { ...result, fee: result.feeInStock, feeBps: pool.feeBps, dynamicFee: pool.dynamicFee };
      }}
      prepare={(side, amount) => preparePoolSwap(address, pool!, side, amount)}
    />
  );
}
