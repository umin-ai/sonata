"use client";
import { ArrowUpRight } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { TokenName } from "@/app/token-identity";
import { explorer, type TreasurySnapshot } from "@/lib/treasury/runtime";
import { formatProgress } from "@/lib/treasury/graduation";
import { formatUnits } from "@/lib/treasury/units";

// Progress toward this market's own migration threshold, read from its pool
// and config on-chain. Three states: on the curve, curve complete but not yet
// migrated, and graduated to a DAMM v2 pool.
export function GraduationProgress({
  data,
  quote,
  compact = false,
}: {
  data: TreasurySnapshot | null;
  quote: string;
  compact?: boolean;
}) {
  if (!data)
    return (
      <div className="graduation" aria-busy="true">
        <div className="graduation-head">
          <span>Graduation</span>
          <strong>—</strong>
        </div>
        <Progress value={0} aria-label="Graduation progress loading" />
      </div>
    );
  const percent = formatProgress(data.graduationBps);
  const label =
    data.graduationStage === "graduated"
      ? "Graduated"
      : data.graduationStage === "complete"
        ? "Curve complete · migration pending"
        : `${percent} to graduation`;
  return (
    <div className="graduation" data-stage={data.graduationStage}>
      <div className="graduation-head">
        <span>Graduation</span>
        <strong>{label}</strong>
      </div>
      <Progress
        value={data.graduationBps / 100}
        aria-label={`Graduation progress ${percent}`}
      />
      {data.graduationStage === "curve" && (
        <p className="graduation-note">
          {formatUnits(data.quoteReserve)} of{" "}
          {formatUnits(data.migrationQuoteThreshold)} <TokenName symbol={quote} />{" "}
          in the curve
          {!compact && (
            <>
              {" "}· {formatUnits(data.remainingToGraduate)} {quote} more graduates it
              to a DAMM v2 pool
            </>
          )}
        </p>
      )}
      {data.graduationStage === "complete" && !compact && (
        <p className="graduation-note">
          The curve has reached its threshold. Anyone can now trigger the
          migration to DAMM v2.
        </p>
      )}
      {data.graduationStage === "graduated" && data.dammPool && (
        <p className="graduation-note">
          <a
            className="sr-text-link"
            href={explorer("address", data.dammPool)}
            target="_blank"
            rel="noreferrer"
          >
            DAMM v2 pool <ArrowUpRight size={13} />
          </a>
          {!compact && <> · 100% of migrated liquidity is permanently locked</>}
        </p>
      )}
    </div>
  );
}
