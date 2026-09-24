"use client";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TokenName } from "@/app/token-identity";
import {
  hasFloor,
  prepareTreasury,
  type Market,
  type TreasurySnapshot,
} from "@/lib/treasury/runtime";
import { formatUnits, parseUnits } from "@/lib/treasury/units";
import {
  BASE_DECIMALS,
  floorPerMillion,
  floorShare,
  pendingFloor,
} from "@/lib/treasury/floor";
import { useLive } from "./live-context";

// The Stock Floor of a Floor-mode market: half of net trading fees, held by the
// treasury program, redeemable by any holder who burns tokens. The creator
// cannot withdraw it. Renders nothing for markets without a floor.
export function StockFloor({
  data,
  market,
  quote,
  held,
  compact = false,
}: {
  data: TreasurySnapshot | null;
  market: Market;
  quote: string;
  held?: string;
  compact?: boolean;
}) {
  const { address, busy, pending, execute } = useLive();
  const [amount, setAmount] = useState("");
  if (!hasFloor(market.mode) && !hasFloor(data?.mode)) return null;
  const floor = data ? BigInt(data.floor) : 0n,
    supply = data ? BigInt(data.baseSupply) : 0n;
  if (compact)
    return (
      <div className="stock-floor stock-floor-compact">
        <span>
          <ShieldCheck size={14} /> Stock Floor
        </span>
        <strong>
          {data ? formatUnits(floor) : "—"} <TokenName symbol={quote} />
        </strong>
      </div>
    );
  const heldRaw = held ? BigInt(held) : 0n;
  let burn = 0n;
  try {
    burn = amount ? parseUnits(amount, BASE_DECIMALS) : 0n;
  } catch {
    burn = 0n;
  }
  const payout = floorShare(floor, burn, supply);
  const toAdd = data
    ? pendingFloor(
        data.migrated ? 0n : BigInt(data.uncollected),
        BigInt(data.unallocated),
      )
    : 0n;
  const enabled = !!address && !busy && !pending && !!data;
  return (
    <div className="stock-floor">
      <div className="stock-floor-head">
        <span>
          <ShieldCheck size={16} /> Stock Floor
        </span>
        <small>Creator can never withdraw it</small>
      </div>
      <strong className="stock-floor-total">
        {data ? formatUnits(floor) : "—"} <TokenName symbol={quote} />
      </strong>
      <p className="stock-floor-note">
        {market.mode === "standardFloor" ? "A quarter" : "Half"} of net trading fees builds this floor. Any holder can burn{" "}
        {market.symbol} for their share, paid in {quote}.
      </p>
      <div className="sr-detail-row">
        <span>Per 1M {market.symbol}</span>
        <strong>
          {data ? formatUnits(floorPerMillion(floor, supply)) : "—"} {quote}
        </strong>
      </div>
      {address && (
        <div className="sr-detail-row">
          <span>Your {market.symbol}</span>
          <strong>
            {formatUnits(heldRaw, BASE_DECIMALS)} · worth{" "}
            {formatUnits(floorShare(floor, heldRaw, supply))} {quote} at the
            floor
          </strong>
        </div>
      )}
      {data?.migrated ? (
        <p className="stock-floor-note">
          This market graduated. Its floor no longer grows, but it can still be
          redeemed.
        </p>
      ) : (
        toAdd > 0n && (
          <div className="stock-floor-pending">
            <span>
              +{formatUnits(toAdd)} {quote} from new trades is ready to add
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={!enabled}
              onClick={() =>
                void execute(() => prepareTreasury("sync", address, market))
              }
            >
              Add to floor
            </Button>
          </div>
        )
      )}
      <div className="stock-floor-burn">
        <Label htmlFor={`burn-${market.pool}`}>
          Burn {market.symbol} for {quote}
        </Label>
        <div className="stock-floor-input">
          <Input
            id={`burn-${market.pool}`}
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.trim())}
          />
          <Button
            type="button"
            variant="outline"
            disabled={heldRaw === 0n}
            onClick={() => setAmount(formatUnits(heldRaw, BASE_DECIMALS))}
          >
            Max
          </Button>
        </div>
        <p className="stock-floor-note">
          {burn > heldRaw
            ? `You hold ${formatUnits(heldRaw, BASE_DECIMALS)} ${market.symbol}.`
            : burn > 0n
            ? payout > 0n
              ? `You receive ${formatUnits(payout)} ${quote}.`
              : "Too few tokens to redeem any stock at the current floor."
            : "Your tokens are burned and you receive their exact share. Nobody else's share goes down."}
        </p>
        <Button
          disabled={!enabled || burn === 0n || burn > heldRaw || payout === 0n}
          onClick={() =>
            void execute(() =>
              prepareTreasury("redeem", address, market, amount),
            )
          }
        >
          Review burn
        </Button>
      </div>
    </div>
  );
}
