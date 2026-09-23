"use client";
import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { TokenName } from "@/app/token-identity";
import { explorer, type TreasurySnapshot } from "@/lib/treasury/runtime";
import { formatProgress, type Heat } from "@/lib/treasury/graduation";
import { formatUnits } from "@/lib/treasury/units";

// USD per quote stock token, shared by every bar on the page and refetched at
// most once a minute. Null when the stock has no usable price.
const prices = new Map<string, { at: number; promise: Promise<number | null> }>();
function usdPrice(symbol: string) {
  const hit = prices.get(symbol);
  if (hit && Date.now() - hit.at < 60_000) return hit.promise;
  const promise = fetch(`/api/stock-price?symbol=${encodeURIComponent(symbol)}`)
    .then((r) => (r.ok ? (r.json() as Promise<{ price?: unknown; error?: string }>) : null))
    .then((d) => (typeof d?.price === "number" && d.price > 0 && !d.error ? d.price : null))
    .catch(() => null);
  prices.set(symbol, { at: Date.now(), promise });
  return promise;
}
function useUsdPrice(symbol: string) {
  const [price, setPrice] = useState<{ symbol: string; value: number | null } | null>(null);
  useEffect(() => {
    let active = true;
    void usdPrice(symbol).then((value) => {
      if (active) setPrice({ symbol, value });
    });
    return () => {
      active = false;
    };
  }, [symbol]);
  return price?.symbol === symbol ? price.value : null;
}

const quoteAmount = (n: number) =>
  n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toPrecision(3);
// A market cap in dollars when the stock has a price, else in the stock token.
function money(cap: number, usd: number | null, quote: string, compact = false) {
  if (usd === null) return `${quoteAmount(cap)} ${quote}`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 0,
  }).format(cap * usd);
}

const ICON: Record<Heat, string> = { new: "", heating: "🔥", fire: "🔥", complete: "🔥", graduated: "🔥🎓" };

// Three chevron segments, one per milestone: heating up at a third of the
// threshold, on fire at two thirds, graduation at the end.
export function CurveBar({ bps, label }: { bps: number; label: string }) {
  return (
    <div className="curve-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={bps / 100}>
      {[0, 1, 2].map((i) => {
        const fill = Math.min(1, Math.max(0, (bps / 10_000) * 3 - i));
        return (
          <span key={i} className="curve-bar-segment">
            <i style={{ "--fill": fill } as React.CSSProperties} />
          </span>
        );
      })}
    </div>
  );
}

// Progress toward this market's own migration threshold, read from its pool
// and config on-chain, with the market cap at which it heats up, catches fire
// and graduates. Shared by market cards (compact) and the market page.
export function GraduationProgress({
  data,
  quote,
  compact = false,
}: {
  data: TreasurySnapshot | null;
  quote: string;
  compact?: boolean;
}) {
  const usd = useUsdPrice(quote);
  if (!data)
    return (
      <div className="graduation" aria-busy="true">
        <div className="graduation-head">
          <span>{compact ? "Market cap" : "Bonding curve progress"}</span>
          <strong>—</strong>
        </div>
        <CurveBar bps={0} label="Bonding curve progress loading" />
      </div>
    );
  const { heat, graduationBps: bps, marketCap, milestoneCaps: [heatCap, fireCap, gradCap] } = data;
  const percent = formatProgress(bps);
  const status =
    heat === "graduated" ? "Graduated" : heat === "complete" ? "Curve complete" : percent;
  const bar = <CurveBar bps={bps} label={`Bonding curve progress ${percent}`} />;
  if (compact)
    return (
      <div className="graduation" data-heat={heat}>
        <div className="graduation-head">
          <span>
            MC <b>{money(marketCap, usd, quote, true)}</b> {ICON[heat]}
          </span>
          <strong>{status}</strong>
        </div>
        {bar}
      </div>
    );
  const marks = [
    heat === "new"
      ? ["Heats up at", money(heatCap, usd, quote)]
      : heat === "heating"
        ? ["This token is heating up! 🔥"]
        : ["Heated up at", money(heatCap, usd, quote)],
    heat === "fire"
      ? ["This token is on fire! 🔥"]
      : [heat === "new" || heat === "heating" ? "On fire at" : "Caught fire at", money(fireCap, usd, quote)],
    heat === "graduated"
      ? ["Graduated 🎓 at", money(gradCap, usd, quote)]
      : heat === "complete"
        ? ["Curve complete", "migration pending"]
        : ["Graduates at", money(gradCap, usd, quote)],
  ];
  return (
    <div className="graduation" data-heat={heat}>
      <div className="graduation-head">
        <span>
          Bonding curve progress: <b>{status}</b>
        </span>
        <strong>
          MC {money(marketCap, usd, quote)} {ICON[heat]}
        </strong>
      </div>
      {bar}
      <div className="curve-marks">
        {marks.map(([text, value], i) => (
          <div key={i} className={value ? undefined : "current"}>
            <span>{text}</span>
            {value && <strong>{value}</strong>}
          </div>
        ))}
      </div>
      {heat !== "graduated" && heat !== "complete" && (
        <p className="graduation-note">
          {formatUnits(data.quoteReserve)} of {formatUnits(data.migrationQuoteThreshold)}{" "}
          <TokenName symbol={quote} /> in the curve · {formatUnits(data.remainingToGraduate)} {quote} more
          graduates it to a DAMM v2 pool
        </p>
      )}
      {heat === "complete" && (
        <p className="graduation-note">
          The curve has reached its threshold. Anyone can now trigger the migration to DAMM v2.
        </p>
      )}
      {heat === "graduated" && data.dammPool && (
        <p className="graduation-note">
          <a className="sr-text-link" href={explorer("address", data.dammPool)} target="_blank" rel="noreferrer">
            DAMM v2 pool <ArrowUpRight size={13} />
          </a>{" "}
          · 100% of migrated liquidity is permanently locked
        </p>
      )}
      {usd !== null && (
        <p className="graduation-note">
          Dollar values use the real stock token&apos;s price on Solana. Test tokens have no value.
        </p>
      )}
    </div>
  );
}
