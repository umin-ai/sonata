"use client";
import { TokenName, TokenPair } from "@/app/token-identity";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLive } from "@/app/onchain/live-session";
import {
  discoverMarkets,
  readTreasury,
  type Market,
  type TreasurySnapshot,
} from "@/lib/treasury/runtime";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { formatUnits } from "@/lib/treasury/units";
import { REWARDS_MINT } from "@/lib/treasury/quote-assets";
export function useReserves() {
  const { address, revision } = useLive(),
    [rows, setRows] = useState<{ market: Market; state: TreasurySnapshot }[]>(
      [],
    ),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    setRows([]);
    setError("");
    if (!address) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      // Only reserves this page can use: the creator's, withdrawable (not a
      // Stock Floor, which belongs to holders), and in mSPY, the asset of the
      // ROOM/mSPY pool and of the rewards program.
      const markets = (await discoverMarkets()).filter(
          (m) => m.creator === address && (m.mode ?? "duet") === "duet" && m.quoteMint === REWARDS_MINT,
        ),
        next = [];
      for (const market of markets)
        next.push({ market, state: await readTreasury(market) });
      if (id === request.current) setRows(next);
    } catch (e) {
      if (id === request.current)
        setError(e instanceof Error ? e.message : "Reserves unavailable");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [address]);
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh, revision]);
  const source = rows.find((r) => r.market.treasury === selected) ?? rows[0];
  return { rows, source, selected, setSelected, error, loading, refresh };
}
export function ReservePicker({
  reserves,
}: {
  reserves: ReturnType<typeof useReserves>;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="reserve-source">Creator reserve</Label>
      <Select
        value={reserves.source?.market.treasury ?? ""}
        onValueChange={reserves.setSelected}
      >
        <SelectTrigger id="reserve-source">
          <SelectValue placeholder="Connect a market’s creator wallet" />
        </SelectTrigger>
        <SelectContent>
          {reserves.rows.map((r) => (
            <SelectItem value={r.market.treasury} key={r.market.treasury}>
              <TokenName symbol={r.market.symbol} /> ·{" "}
              {formatUnits(r.state.available)}{" "}
              <TokenName symbol="mSPY" size={20} />
              available
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!reserves.loading && !reserves.error && !reserves.rows.length && (
        <p className="sr-note">
          No usable reserve for this wallet. Reserves here come from mSPY markets
          you created that are not Backed tokens, after their fees are collected and
          allocated. A Backed token&apos;s backing belongs to holders and cannot be withdrawn.
        </p>
      )}
    </div>
  );
}
