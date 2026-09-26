"use client";
import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TokenName } from "@/app/token-identity";
import {
  connection,
  type Market,
  type TreasurySnapshot,
} from "@/lib/treasury/runtime";
import { formatUnits } from "@/lib/treasury/units";
import {
  creatorShareLabel,
  findCreatorPosition,
  formatBps,
  prepareCreatorClaim,
  type CreatorPositionRead,
} from "@/lib/liquidity/creator-position";
import { useLive } from "./live-context";

// The creator's permanently locked DAMM v2 position on a graduated market.
// Its liquidity can never be withdrawn, but the NFT holder claims its trading
// fees. The creator sees the position and can claim; everyone else gets one
// read-only line. Renders nothing before graduation, and nothing for markets
// whose config gave the creator no share of the migrated liquidity.
export function CreatorPosition({
  data,
  market,
  quote,
}: {
  data: TreasurySnapshot | null;
  market: Market;
  quote: string;
}) {
  const { address, busy, pending, revision, execute } = useLive();
  const graduated = !!data?.migrated;
  const [read, setRead] = useState<{ pool: string; value: CreatorPositionRead } | null>(null);
  const [error, setError] = useState<{ pool: string; message: string } | null>(null);
  useEffect(() => {
    if (!graduated) return;
    let active = true;
    findCreatorPosition(connection, market)
      .then((value) => {
        if (!active) return;
        setRead({ pool: market.pool, value });
        setError(null);
      })
      .catch((e) => {
        if (active)
          setError({
            pool: market.pool,
            message: e instanceof Error ? e.message : "Position unavailable.",
          });
      });
    return () => {
      active = false;
    };
  }, [graduated, market, revision]);
  if (!graduated) return null;
  const r = read?.pool === market.pool ? read.value : null;
  if (!r)
    return error?.pool === market.pool ? (
      <p className="sr-note">Graduated pool position unavailable: {error.message}</p>
    ) : null;
  if (r.creatorPercent === 0) return null;
  const p = r.position;
  if (address !== r.owner)
    return (
      <p className="sr-note">
        The creator owns {creatorShareLabel(r.creatorPercent)} of the locked liquidity and earns
        its fees.
      </p>
    );
  if (!p)
    return (
      <p className="sr-note">
        Your position NFT for this pool is no longer in this wallet. Its fees go to whoever holds it.
      </p>
    );
  const a = BigInt(p.unclaimedA),
    b = BigInt(p.unclaimedB),
    claimedB = BigInt(p.claimedB);
  const enabled = !!address && !busy && !pending && (a > 0n || b > 0n);
  return (
    <div className="sr-panel creator-position my-3 grid gap-3">
      <span className="sr-eyebrow">
        <Lock size={14} /> Your graduated pool position · earns {formatBps(p.feeShareBps)} of this
        pool&apos;s trading fees forever
      </span>
      <div className="sr-detail-row">
        <span>Unclaimed stock fees</span>
        <strong>
          {formatUnits(b, market.quoteDecimals)} <TokenName symbol={quote} />
          {a > 0n && (
            <>
              <br />
              {formatUnits(a, market.baseDecimals)} <TokenName symbol={market.symbol} />
            </>
          )}
        </strong>
      </div>
      <div className="sr-detail-row">
        <span>Locked liquidity</span>
        <strong>
          {formatBps(p.lockedBps)} permanently locked · {formatBps(p.poolShareBps)} of the pool
        </strong>
      </div>
      {claimedB > 0n && (
        <div className="sr-detail-row">
          <span>Claimed so far</span>
          <strong>
            {formatUnits(claimedB, market.quoteDecimals)} <TokenName symbol={quote} />
          </strong>
        </div>
      )}
      <Button
        disabled={!enabled}
        onClick={() => void execute(() => prepareCreatorClaim(address, market))}
      >
        Claim fees
      </Button>
      <p className="sr-note">
        This liquidity can never be withdrawn, but its trading fees are yours to claim. Your share
        falls if others add liquidity to this pool.
      </p>
    </div>
  );
}
