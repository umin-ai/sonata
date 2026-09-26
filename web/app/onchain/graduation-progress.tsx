"use client";
import { ArrowUpRight } from "lucide-react";
import { explorer, type TreasurySnapshot } from "@/lib/treasury/runtime";
import { formatProgress, type Heat } from "@/lib/treasury/graduation";
import { formatUnits } from "@/lib/treasury/units";
import { useUsdPrice } from "./usd-price";

// A stock amount from atoms, short: 1.79, 3.48, 0.0123.
const stock = (atoms: string | bigint) => {
  const n = Number(formatUnits(atoms));
  // Tiny amounts in plain digits (0.0000001), not "1.00e-7".
  return n > 0 && n < 0.001 ? formatUnits(atoms) : quoteAmount(n);
};
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

const HEAT_LABEL: Record<Heat, string> = {
  new: "New market",
  heating: "Heating up",
  fire: "On fire",
  complete: "Curve complete",
  graduated: "Graduated",
};

function HeatSignal({ heat }: { heat: Heat }) {
  if (heat === "new") return null;
  return (
    <span className="sonata-heat-signal" data-heat={heat} role="img" aria-label={HEAT_LABEL[heat]} title={HEAT_LABEL[heat]}>
      <svg className="sonata-heat-flame" viewBox="0 0 24 28" fill="none" aria-hidden="true">
        <path d="M13 1 15 8 18 5C18 10 23 13 23 18A11 10 0 0 1 1 18C1 14 3 10 7 7L6 14C11 11 13 6 13 1Z" fill="currentColor" />
        <path className="sonata-heat-core" d="m13 12 1 6 3-2c2 4 0 8-5 8-4 0-6-4-4-7l1 3c2-2 3-5 4-8Z" />
      </svg>
      {heat === "graduated" && (
        <svg className="sonata-heat-cap" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <path d="m2 10 12-7 12 7-12 7L2 10Z" fill="currentColor" />
          <path d="M7 15v6l7 4 7-4v-6l-7 4-7-4Z" fill="currentColor" />
          <path d="M25 12v9m0 0-2 3m2-3 2 3" stroke="currentColor" strokeWidth="2" strokeLinejoin="miter" />
          <path d="m9 10 5-3 5 3" stroke="var(--background)" strokeWidth="1.5" />
        </svg>
      )}
    </span>
  );
}

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
          <span className="sonata-market-cap">
            <span>MC <b>{money(marketCap, usd, quote, true)}</b></span>
            <HeatSignal heat={heat} />
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
        ? ["This token is heating up!"]
        : ["Heated up at", money(heatCap, usd, quote)],
    heat === "fire"
      ? ["This token is on fire!"]
      : [heat === "new" || heat === "heating" ? "On fire at" : "Caught fire at", money(fireCap, usd, quote)],
    heat === "graduated"
      ? ["Graduated at", money(gradCap, usd, quote)]
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
        <strong className="sonata-market-cap">
          <span>MC {money(marketCap, usd, quote)}</span>
          <HeatSignal heat={heat} />
        </strong>
      </div>
      {bar}
      <div className="curve-marks">
        {marks.map(([text, value], i) => (
          <div key={i} className={value ? undefined : "current"}>
            {/* The heat icons show once, next to the market cap above. */}
            <span>{text}</span>
            {value && <strong>{value}</strong>}
          </div>
        ))}
      </div>
      {/* The curve's numbers as rows, in the stock (dollar values use the real stock's price). */}
      {heat !== "graduated" && heat !== "complete" && (
        <>
          <div className="sr-detail-row">
            <span>In the curve</span>
            <strong>
              {stock(data.quoteReserve)} / {stock(data.migrationQuoteThreshold)} {quote}
            </strong>
          </div>
          <div className="sr-detail-row">
            <span>To graduate</span>
            <strong>
              {stock(data.remainingWithFee)} {quote} more, fee included
            </strong>
          </div>
        </>
      )}
      {heat === "complete" && (
        <div className="sr-detail-row">
          <span>Migration</span>
          <strong>Ready: anyone can trigger it</strong>
        </div>
      )}
      {heat === "graduated" && data.dammPool && (
        <div className="sr-detail-row">
          <span>Pool</span>
          <strong>
            <a className="sr-text-link" href={explorer("address", data.dammPool)} target="_blank" rel="noreferrer">
              DAMM v2 <ArrowUpRight size={13} />
            </a>{" "}
            · liquidity locked forever
          </strong>
        </div>
      )}
    </div>
  );
}
