"use client";
import { TokenName, TokenPair } from "@/app/token-identity";
import { useEffect, useState } from "react";
import Link from "@/app/plain-link";
import { ArrowUpRight, RefreshCw, Sprout } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LiveWallet, useLive } from "@/app/onchain/live-session";
import { formatUnits } from "@/lib/treasury/units";
import { prepareReserveDeployment } from "@/lib/liquidity/runtime";
import { RESERVE_PRICE_GAP_BPS, listGraduatedPools, priceRatioBps } from "@/lib/liquidity/pools";
import { discoverMarkets } from "@/lib/treasury/runtime";
import { ReservePicker, useReserves } from "./reserves";
// The ROOM / mSPY pool's price as a share of ROOM's bonding-curve price, in bps.
function useReservePriceGap() {
  const [gap, setGap] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    discoverMarkets()
      .then(listGraduatedPools)
      .then(
        (list) => {
          const pool = list.pools.find((p) => p.reserve);
          if (active)
            setGap(
              pool?.curveSqrtPrice
                ? priceRatioBps(BigInt(pool.state.sqrtPrice.toString()), pool.curveSqrtPrice)
                : null,
            );
        },
        () => {},
      );
    return () => {
      active = false;
    };
  }, []);
  return gap;
}

export default function CapitalPage() {
  const { address, busy, pending, execute } = useLive(),
    reserves = useReserves(),
    [amount, setAmount] = useState(""),
    source = reserves.source;
  const gap = useReservePriceGap();
  return (
    <>
      <div className="sr-heading">
        <div>
          <span className="sr-eyebrow">SONATA / TREASURY</span>
          <h1>Treasury</h1>
          <p>
            Put your market&apos;s creator reserve into the ROOM / mSPY pool,
            where its trading fees compound.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={reserves.loading}
          onClick={() => void reserves.refresh()}
        >
          <RefreshCw />
          Refresh
        </Button>
      </div>
      <LiveWallet />
      {reserves.error && (
        <Alert variant="destructive">
          <AlertDescription>{reserves.error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="sr-panel">
          <Badge variant="outline">Creator-owned capital</Badge>
          <h3 className="mt-4">
            Deploy into <TokenPair />
          </h3>
          <div className="space-y-4 mt-5">
            <ReservePicker reserves={reserves} />
            {source && (
              <>
                <div className="sr-detail-row">
                  <span>Available reserve</span>
                  <strong>
                    {formatUnits(source.state.available)}{" "}
                    <TokenName symbol="mSPY" />
                  </strong>
                </div>
                <Label htmlFor="deploy-amount">mSPY from reserve</Label>
                <Input
                  id="deploy-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.000001"
                />
                <p className="sr-note">
                  Add matching ROOM from your wallet. Review both amounts before
                  signing. Any unused mSPY buffer returns to your wallet.
                </p>
                {gap !== null && Math.abs(gap - 10_000) > RESERVE_PRICE_GAP_BPS && (
                  <Alert>
                    <AlertDescription>
                      {`The ROOM / mSPY pool prices ROOM at ${Number((gap / 100).toFixed(1))}% of its bonding-curve price. Deploying adds your ROOM and mSPY at the pool's price, and trades between the two can move value out of the pool.`}
                    </AlertDescription>
                  </Alert>
                )}
                <Button
                  disabled={
                    !address ||
                    !!busy ||
                    !!pending ||
                    reserves.loading ||
                    !amount
                  }
                  onClick={() =>
                    void execute(() =>
                      prepareReserveDeployment(address, source.market, amount),
                    )
                  }
                >
                  Review reserve deployment
                </Button>
                <Button variant="ghost" asChild>
                  <Link href={`/onchain?pool=${source.market.pool}`}>
                    Collect and allocate fees
                    <ArrowUpRight />
                  </Link>
                </Button>
              </>
            )}
          </div>
        </Card>
        <Card className="sr-panel">
          <Sprout className="text-lime-300 mb-4" />
          <h3>Fee allocation</h3>
          <p className="sr-note">
            One transaction withdraws your authorized reserve and creates a
            Meteora LP position. If either step fails, both roll back.
          </p>
          <p className="sr-note">
            You own the resulting NFT and manage it, including withdrawals,
            on the Pools page. This does not give community holders a claim on your position.
          </p>
          <div className="flex gap-3 flex-wrap mt-5">
            <Button asChild variant="outline">
              <Link href="/earn?net=devnet&pool=GHHFvUXdyEwVgadW7LRnrnVFPhSwWMs5qauNfcYZuH9v">
                Manage LP positions
                <ArrowUpRight />
              </Link>
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}
