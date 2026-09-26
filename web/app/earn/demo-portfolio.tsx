"use client";
import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import Link from "@/app/plain-link";
import { MeteoraLabel } from "@/app/protocol-identity";
import { TokenName } from "@/app/token-identity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useLive } from "@/app/onchain/live-session";
import { readLiquidity, type LiquiditySnapshot } from "@/lib/liquidity/runtime";
import { formatUnits } from "@/lib/treasury/units";

// The portfolio page's card for the ROOM / mSPY Devnet pool, where creators put
// their reserve. The Pools page's Devnet tab manages these positions.
export function LiquidityPortfolio({ refreshToken = 0 }: { refreshToken?: number }) {
  const { address, revision } = useLive();
  const key = `${address}:${revision}:${refreshToken}`;
  const [read, setRead] = useState<{ key: string; data?: LiquiditySnapshot; error?: string } | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    readLiquidity(address || undefined).then(
      (data) => active && setRead({ key, data }),
      (e) =>
        active && setRead({ key, error: e instanceof Error ? e.message : "Liquidity unavailable" }),
    );
    return () => {
      active = false;
    };
  }, [address, key]);
  const current = read?.key === key ? read : null;
  const data = current?.data ?? null;
  const ownedA = data?.positions.reduce((sum, p) => sum + BigInt(p.a), 0n) ?? 0n,
    ownedB = data?.positions.reduce((sum, p) => sum + BigInt(p.b), 0n) ?? 0n;
  return (
    <Card className="sr-panel mt-6">
      <div className="sr-section-top">
        <div>
          <span className="sr-eyebrow">YOUR LIQUIDITY</span>
          <h3>Your liquidity positions</h3>
        </div>
        <Badge variant="outline">
          <MeteoraLabel>Meteora DAMM v2</MeteoraLabel>
        </Badge>
      </div>
      {current?.error ? (
        <p className="text-destructive">{current.error}</p>
      ) : (
        <>
          <p className="text-xl">
            {!current ? (
              "Reading positions…"
            ) : (
              <>
                {formatUnits(ownedA, 6)} <TokenName symbol="ROOM" /> +{" "}
                {formatUnits(ownedB)} <TokenName symbol="mSPY" />
              </>
            )}
          </p>
          <p className="sr-note">
            {data?.positions.length ?? 0} active positions in the ROOM / mSPY demo pool.
            Redeemable pool assets include compounded fees. These amounts are separate from your
            wallet balance and creator reserves.
          </p>
        </>
      )}
      <Button asChild variant="outline">
        <Link href="/earn?net=devnet&pool=GHHFvUXdyEwVgadW7LRnrnVFPhSwWMs5qauNfcYZuH9v">
          Manage on Pools <ArrowUpRight />
        </Link>
      </Button>
    </Card>
  );
}
