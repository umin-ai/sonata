"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { TokenName } from "@/app/token-identity";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { displayAmount } from "@/lib/liquidity/pools";
import type { Market, PreparedTreasury } from "@/lib/treasury/runtime";
import { formatUnits, parseUnits } from "@/lib/treasury/units";
import { useLive } from "./live-session";
import { WalletConnectButton } from "./wallet-connect";
import { useUsdPrice } from "./usd-price";

export type SwapSide = "buy" | "sell";
/** A live estimate: output and minimum in output atoms, fee in stock atoms. */
export type SwapQuote = {
  out: bigint;
  minimum: bigint;
  fee: bigint;
  /** The pool's base fee in basis points. */
  feeBps?: number;
  dynamicFee?: boolean;
  /** The price move alone, in percent. */
  impact?: number;
  /** The input actually used, fee included (a buy that completes the curve uses less). */
  used?: bigint;
};

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
// The estimate is re-read this often while an amount is typed in, so it follows other trades.
const REQUOTE_MS = 20_000;
const CHIPS = [25, 50, 75, 100] as const;

const usd = (atoms: bigint, decimals: number, price: number | null) =>
  price === null
    ? null
    : `≈ ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format((Number(atoms) / 10 ** decimals) * price)}`;

/**
 * The swap box of a market page, like other launchpads': pick Buy or Sell, type
 * what you pay (or tap a share of your balance), see what you receive, and one
 * button sends it to your wallet to approve. No separate review step.
 */
export function SwapPanel({
  market,
  quoteSymbol: q,
  balances,
  baseToken,
  route,
  quote,
  prepare,
  unavailable,
  fee,
  fillCurve,
}: {
  market: Market;
  quoteSymbol: string;
  balances: { base: string; quote: string } | null;
  /** The token's chip: its image and ticker. */
  baseToken: ReactNode;
  route: string;
  quote: (side: SwapSide, amount: string) => Promise<SwapQuote>;
  prepare: (side: SwapSide, amount: string) => Promise<PreparedTreasury>;
  /** Why trading is off right now (e.g. the pool is still loading). */
  unavailable?: string;
  /** The fee rate to show before a quote: basis points, and whether it rises on fast moves. */
  fee?: { bps: number; dynamic: boolean };
  /** Stock atoms that complete the curve, fee included: offered as a "Fill curve" amount. */
  fillCurve?: bigint;
}) {
  const { address, busy, pending, error: liveError, execute, revision } = useLive();
  const [side, setSide] = useState<SwapSide>("buy");
  // The typed amount clears after each confirmed transaction.
  const [entry, setEntry] = useState({ text: "", revision });
  const amount = entry.revision === revision ? entry.text : "";
  const setAmount = (text: string) => setEntry({ text, revision });
  const stockUsd = useUsdPrice(q);
  const inDecimals = side === "buy" ? market.quoteDecimals : market.baseDecimals,
    outDecimals = side === "buy" ? market.baseDecimals : market.quoteDecimals;
  const outSymbol = side === "buy" ? market.symbol : q;
  const balance = balances ? BigInt(side === "buy" ? balances.quote : balances.base) : null;

  let raw: bigint | null = null,
    invalid = "";
  if (amount.trim())
    try {
      raw = parseUnits(amount.trim(), inDecimals);
      if (raw <= 0n) raw = null;
    } catch (e) {
      invalid = message(e, "Enter an amount.");
    }

  // The estimate: read shortly after typing stops, then every REQUOTE_MS.
  const quoteRef = useRef(quote);
  useEffect(() => {
    quoteRef.current = quote;
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (raw === null) return;
    const timer = setInterval(() => setTick((t) => t + 1), REQUOTE_MS);
    return () => clearInterval(timer);
  }, [raw]);
  const key = raw !== null && !unavailable ? `${side}:${raw}:${revision}:${tick}` : "";
  const [read, setRead] = useState<{ key: string; q?: SwapQuote; error?: string; last?: SwapQuote } | null>(null);
  useEffect(() => {
    if (!key) return;
    let active = true;
    const timer = setTimeout(() => {
      quoteRef.current(side, amount.trim()).then(
        (result) => active && setRead({ key, q: result, last: result }),
        (e) => active && setRead((prev) => ({ key, error: message(e, "Quote unavailable."), last: prev?.last })),
      );
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, side, amount]);
  const current = read?.key === key ? read : null;
  // While a re-read loads, the last estimate for the same amount stays on screen.
  const shown = current?.q ?? (read?.key.startsWith(`${side}:${raw}:`) ? read?.last : undefined);
  const quoteError = invalid || current?.error;
  const short = raw !== null && balance !== null && raw > balance;
  const ready = !!address && !busy && !pending && !unavailable && raw !== null && !!shown && !quoteError && !short;

  const rate = shown?.feeBps !== undefined ? { bps: shown.feeBps, dynamic: !!shown.dynamicFee } : fee;
  const feeLine = rate ? `${Number((rate.bps / 100).toFixed(2))}%${rate.dynamic ? ", more on fast moves" : ""}` : null;
  const payUsd = raw !== null ? (side === "buy" ? usd(raw, inDecimals, stockUsd) : shown ? usd(shown.out + shown.fee, outDecimals, stockUsd) : null) : null;
  const receiveUsd = shown ? (side === "buy" ? usd((raw ?? 0n) - shown.fee, inDecimals, stockUsd) : usd(shown.out, outDecimals, stockUsd)) : null;

  return (
    <Card className="sr-panel swap-panel" data-side={side}>
      <div className="swap-side" role="radiogroup" aria-label="Trade direction">
        {(["buy", "sell"] as const).map((s) => (
          <button
            type="button"
            role="radio"
            key={s}
            data-side={s}
            aria-checked={side === s}
            disabled={!!busy}
            onClick={() => {
              setSide(s);
              setAmount("");
            }}
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>
      <div className="swap-box">
        <div className="swap-box-top">
          <span>You pay</span>
          <span>Balance {balance !== null ? displayAmount(balance, inDecimals) : "—"}</span>
        </div>
        <div className="swap-box-main">
          <input
            aria-label={`Amount of ${side === "buy" ? q : market.symbol} to pay`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            disabled={!!busy}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          />
          <span className="swap-token">{side === "buy" ? <TokenName symbol={q} size={20} /> : baseToken}</span>
        </div>
        <span className="swap-usd">{payUsd ?? " "}</span>
      </div>
      {balance !== null && balance > 0n && (
        <div className="swap-chips">
          {side === "buy" && fillCurve !== undefined && fillCurve > 0n && fillCurve <= balance && (
            <button type="button" disabled={!!busy} onClick={() => setAmount(formatUnits(fillCurve, inDecimals))}>
              Fill curve
            </button>
          )}
          {CHIPS.map((pct) => (
            <button
              type="button"
              key={pct}
              disabled={!!busy}
              onClick={() => setAmount(formatUnits((balance * BigInt(pct)) / 100n, inDecimals))}
            >
              {pct === 100 ? "Max" : `${pct}%`}
            </button>
          ))}
        </div>
      )}
      <div className="swap-box">
        <div className="swap-box-top">
          <span>You receive</span>
        </div>
        <div className="swap-box-main">
          <output>{shown ? displayAmount(shown.out, outDecimals) : raw !== null && !quoteError ? "…" : "0"}</output>
          <span className="swap-token">{side === "buy" ? baseToken : <TokenName symbol={q} size={20} />}</span>
        </div>
        <span className="swap-usd">{receiveUsd ?? " "}</span>
      </div>
      <div className="swap-rows">
        {shown?.used !== undefined && raw !== null && shown.used < raw && (
          <div>
            <span>Completes the curve</span>
            <strong>
              Uses {displayAmount(shown.used, inDecimals)} {side === "buy" ? q : market.symbol}; the rest stays
            </strong>
          </div>
        )}
        {shown && (
          <div>
            <span>Minimum received</span>
            <strong>
              {displayAmount(shown.minimum, outDecimals)} {outSymbol}
            </strong>
          </div>
        )}
        <div>
          <span>Fee</span>
          <strong>
            {feeLine ?? "—"}
            {shown && shown.fee > 0n ? ` · ${displayAmount(shown.fee, market.quoteDecimals)} ${q}` : ""}
          </strong>
        </div>
        {shown?.impact !== undefined && shown.impact >= 1 && (
          <div data-tone="warn">
            <span>Price impact</span>
            <strong>{Number(shown.impact.toFixed(2))}%</strong>
          </div>
        )}
        <div>
          <span>Slippage</span>
          <strong>0.5%</strong>
        </div>
        <div>
          <span>Route</span>
          <strong>{route}</strong>
        </div>
      </div>
      {!address ? (
        <WalletConnectButton />
      ) : (
        <Button
          className="swap-cta"
          data-side={side}
          disabled={!ready}
          onClick={() => void execute(() => prepare(side, amount.trim()), { direct: true })}
        >
          {busy || (side === "buy" ? `Buy ${market.symbol}` : `Sell ${market.symbol}`)}
        </Button>
      )}
      {(unavailable || short || quoteError || liveError) && (
        <p className="swap-hint" data-tone={unavailable ? undefined : "error"} role="status">
          {unavailable ??
            (short ? `Not enough ${side === "buy" ? q : market.symbol} in your wallet.` : (quoteError ?? liveError))}
        </p>
      )}
    </Card>
  );
}
