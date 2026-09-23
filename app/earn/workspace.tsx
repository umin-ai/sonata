"use client";
import stockPools from "@/lib/liquidity/stock-markets.json";
import { MeteoraLabel } from "@/app/protocol-identity";
import { TokenName, TokenPair } from "@/app/token-identity";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "@/app/plain-link";
import {
  ArrowDownUp,
  ArrowUpRight,
  RefreshCw,
  Layers3,
  Sprout,
  ShieldCheck,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { LiveWallet, useLive } from "@/app/onchain/live-session";
import {
  readLiquidity,
  prepareDeposit,
  prepareWithdrawal,
  prepareLiquidityTrade,
  liquidityMarket,
  type LiquiditySnapshot,
} from "@/lib/liquidity/runtime";
import { formatUnits } from "@/lib/treasury/units";
import { explorer } from "@/lib/treasury/runtime";
const short = (s: string) => `${s.slice(0, 5)}…${s.slice(-5)}`;
const amount = (s: string, d = 8) => formatUnits(s, d);
function useLiquidity(refreshToken = 0) {
  const { address, revision } = useLive();
  const [data, setData] = useState<LiquiditySnapshot | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      const next = await readLiquidity(address || undefined);
      if (id === request.current) setData(next);
    } catch (e) {
      if (id === request.current) {
        setData(null);
        setError(e instanceof Error ? e.message : "Liquidity unavailable");
      }
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [address]);
  useEffect(() => {
    setData(null);
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh, revision, refreshToken]);
  return { data, error, loading, refresh };
}
export function LiquidityPortfolio({
  refreshToken = 0,
}: {
  refreshToken?: number;
}) {
  const { data, error, loading } = useLiquidity(refreshToken);
  const ownedA =
      data?.positions.reduce((sum, p) => sum + BigInt(p.a), 0n) ?? 0n,
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
      {error ? (
        <p className="text-destructive">{error}</p>
      ) : (
        <>
          <p className="text-xl">
            {loading ? (
              "Reading positions…"
            ) : (
              <>
                {formatUnits(ownedA, 6)} <TokenName symbol="ROOM" /> +{" "}
                {formatUnits(ownedB)} <TokenName symbol="mSPY" />
              </>
            )}
          </p>
          <p className="sr-note">
            {data?.positions.length ?? 0} active positions. Redeemable pool
            assets include compounded fees. These amounts are separate from your
            wallet balance and creator reserves.
          </p>
        </>
      )}
      <Button asChild variant="outline">
        <Link href="/earn">
          Manage liquidity <ArrowUpRight />
        </Link>
      </Button>
    </Card>
  );
}
export function LiquidityWorkspace() {
  const { address, busy, pending, execute } = useLive();
  const { data, error, loading, refresh } = useLiquidity();
  const [deposit, setDeposit] = useState("100000"),
    [trade, setTrade] = useState("0.0001"),
    [side, setSide] = useState<"buy" | "sell">("buy");
  const enabled = !!address && !busy && !pending && !loading && !!data;
  return (
    <>
      <div className="sr-heading">
        <div>
          <span className="sr-eyebrow">SONATA / EARN</span>
          <h1>Pools</h1>
          <p>
            Explore stock liquidity strategies and earn from swap fees. Check availability before choosing a vault.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>
      <section aria-labelledby="stock-vaults-heading" className="mb-8">
        <div className="sr-section-top"><div><h2 id="stock-vaults-heading">Stock pools</h2><p>Four stock strategies. Availability is shown per pool; all deployed pools use Devnet test assets.</p></div><Badge variant="outline">Liquidity pools</Badge></div>
        <div className="exchange-vault-table"><div className="exchange-vault-row exchange-vault-labels"><span>Pool / asset</span><span>Strategy</span><span>Fee APR</span><span>Status</span><span /></div>
          {[["spy","SPYx","S&P 500"],["nvda","NVDAx","NVIDIA"],["qqq","QQQx","Nasdaq 100"],["tsla","TSLAx","Tesla"]].map(([id,symbol,name]) => {
            const deployed=(stockPools as {id:string}[]).some(p=>p.id===id);
            return <div className="exchange-vault-row" key={id}><div><TokenName symbol={symbol} size={32}/><p>{name} · {deployed?"MockUSDC":"USDC preview"}</p></div><div><strong>Liquidity fees</strong><p>Stock + stablecoin</p></div><details><summary>{deployed?"Collecting data":"Not live"}</summary><p>Fee APR annualizes observed net LP fees relative to pool value. This vault has no verified observation period yet. External trading volume is not this vault’s return.</p></details><Badge variant="outline">{deployed?"Devnet":"Preview"}</Badge><Button asChild variant="outline"><Link href={`/vaults/${id}`}>Explore <ArrowUpRight size={16}/></Link></Button></div>
          })}
        </div>
      </section>
      <div className="sr-section-top" id="devnet-liquidity"><div><h2>Try liquidity on Devnet</h2><p>ROOM / mSPY supports actual test deposits, swaps and withdrawals. Supply both tokens; fees compound into your LP position.</p></div><Badge variant="outline">Working test pool</Badge></div>
      <div className="flex flex-wrap gap-2 mb-6">
        <Badge variant="outline">
          <span className="size-1.5 rounded-full bg-lime-400 mr-2" />
          Live Devnet
        </Badge>
        <Badge variant="outline">Full-range · no lockup</Badge>
        <Badge variant="outline">100% of net LP fees compound</Badge>
      </div>
      <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr] mb-6">
        <Card className="sr-panel">
          <div className="sr-section-top">
            <div>
              <span className="sr-eyebrow">COMMUNITY × MOCK STOCK</span>
              <h3 className="!text-3xl">
                <TokenPair size={32} />
              </h3>
            </div>
            <Sprout size={28} className="text-lime-300" />
          </div>
          <div className="sr-detail-row">
            <span>
              <TokenName symbol="ROOM" /> supplied
            </span>
            <strong>{data ? amount(data.a, 6) : "—"}</strong>
          </div>
          <div className="sr-detail-row">
            <span>
              <TokenName symbol="mSPY" /> supplied
            </span>
            <strong>{data ? amount(data.b) : "—"}</strong>
          </div>
          <div className="sr-detail-row">
            <span>LP fees earned · lifetime</span>
            <strong className="text-lime-300">
              {data ? amount(data.lpFeesB) : "—"} <TokenName symbol="mSPY" />
            </strong>
          </div>
          <p className="sr-note mt-4">
            Net trading fees are reinvested automatically. Redeem your share to
            receive them. Devnet assets have no market valuation.
          </p>
          <a
            className="sr-text-link"
            href={explorer("address", liquidityMarket.pool)}
            target="_blank"
            rel="noreferrer"
          >
            Pool {short(liquidityMarket.pool)}
            <ArrowUpRight size={14} />
          </a>
          {data && (
            <p className="sr-note mt-2">
              Read at slot {data.slot.toLocaleString()}
            </p>
          )}
        </Card>
        <Card className="sr-panel">
          <span className="sr-eyebrow">HOW VALUE FLOWS</span>
          <h3>How it works</h3>
          <div className="space-y-5 mt-5">
            {[
              [
                Layers3,
                "You supply both assets",
                "Your wallet receives an NFT controlling your share of the pool.",
              ],
              [
                ArrowDownUp,
                "Traders pay a 1% fee",
                "Meteora deducts its protocol share. All remaining LP fees stay in the pool.",
              ],
              [
                ShieldCheck,
                "You redeem your share",
                "Withdraw part or all of your unlocked position, back to your wallet.",
              ],
            ].map(([Icon, title, text]) => {
              const I = Icon as typeof Layers3;
              return (
                <div className="flex gap-3" key={String(title)}>
                  <I size={18} className="shrink-0 mt-1 text-lime-300" />
                  <div>
                    <strong>{String(title)}</strong>
                    <p className="sr-note !mt-1">{String(text)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <LiveWallet />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="sr-panel">
          <Tabs defaultValue="supply">
            <TabsList className="mb-5">
              <TabsTrigger value="supply">Supply liquidity</TabsTrigger>
              <TabsTrigger value="trade">Trade this pool</TabsTrigger>
            </TabsList>
            <TabsContent value="supply" className="space-y-4">
              <h3>Add liquidity</h3>
              <p className="sr-note">
                Supply ROOM and the matching mSPY at the current pool ratio. The
                review shows both amounts and their maximum debits before you
                sign.
              </p>
              <Label htmlFor="supply-room">
                <TokenName symbol="ROOM" /> to supply
              </Label>
              <Input
                id="supply-room"
                inputMode="decimal"
                value={deposit}
                onChange={(e) => setDeposit(e.target.value)}
              />
              <p className="sr-note">
                Wallet:{" "}
                {data?.balance ? (
                  <>
                    {amount(data.balance.base, 6)} <TokenName symbol="ROOM" /> ·{" "}
                    {amount(data.balance.quote)} <TokenName symbol="mSPY" />
                  </>
                ) : (
                  "Connect to read balances"
                )}
              </p>
              <Button
                className="w-full"
                disabled={!enabled || !deposit}
                onClick={() =>
                  void execute(() => prepareDeposit(address, deposit))
                }
              >
                Review deposit
              </Button>
              <p className="sr-note">
                Each deposit creates its own position NFT. You keep withdrawal
                control. Position composition changes with trading; fees do not
                guarantee a profit.
              </p>
            </TabsContent>
            <TabsContent value="trade" className="space-y-4">
              <h3>Swap</h3>
              <p className="sr-note">
                This swap uses the DAMM pool above. Its net LP fees compound
                here. The separate launch market has its own creator-fee policy.
              </p>
              <Tabs
                value={side}
                onValueChange={(v) => {
                  setSide(v as "buy" | "sell");
                  setTrade(v === "buy" ? "0.0001" : "100000");
                }}
              >
                <TabsList>
                  <TabsTrigger value="buy">
                    Buy <TokenName symbol="ROOM" />
                  </TabsTrigger>
                  <TabsTrigger value="sell">
                    Sell <TokenName symbol="ROOM" />
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <Label htmlFor="pool-trade">
                <TokenName symbol={side === "buy" ? "mSPY" : "ROOM"} /> to spend
              </Label>
              <Input
                id="pool-trade"
                inputMode="decimal"
                value={trade}
                onChange={(e) => setTrade(e.target.value)}
              />
              <Button
                className="w-full"
                disabled={!enabled || !trade}
                onClick={() =>
                  void execute(() =>
                    prepareLiquidityTrade(address, side, trade),
                  )
                }
              >
                Review pool swap
              </Button>
            </TabsContent>
          </Tabs>
        </Card>
        <Card className="sr-panel">
          <span className="sr-eyebrow">YOUR POSITIONS</span>
          <h3>Your positions</h3>
          {loading ? (
            <p className="sr-note">Reading Solana…</p>
          ) : !data?.positions.length ? (
            <div className="py-8">
              <Layers3 size={24} className="mb-3 text-muted-foreground" />
              <p>
                {address
                  ? "No active liquidity positions."
                  : "Connect your wallet to see positions."}
              </p>
              <p className="sr-note">
                A deposit creates ownership here. Simply holding ROOM does not.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {data.positions.map((p) => (
                <div
                  key={p.address}
                  className="rounded-xl border border-white/10 p-4"
                >
                  <div className="flex justify-between gap-3">
                    <a
                      className="sr-text-link"
                      target="_blank"
                      rel="noreferrer"
                      href={explorer("address", p.address)}
                    >
                      {short(p.address)}
                      <ArrowUpRight size={12} />
                    </a>
                    <Badge variant="outline">{p.sharePercent}% of pool</Badge>
                  </div>
                  <p className="my-4 text-lg">
                    {amount(p.a, 6)} <TokenName symbol="ROOM" />
                    <br />
                    {amount(p.b)} <TokenName symbol="mSPY" />
                  </p>
                  <p className="sr-note">
                    Current redeemable assets, including compounded fees.
                  </p>
                  <div className="flex flex-wrap gap-2 mt-3">
                    <Button
                      variant="outline"
                      disabled={!enabled}
                      onClick={() =>
                        void execute(() =>
                          prepareWithdrawal(address, p.address, 5000),
                        )
                      }
                    >
                      Withdraw 50%
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!enabled}
                      onClick={() =>
                        void execute(() =>
                          prepareWithdrawal(address, p.address, 10000),
                        )
                      }
                    >
                      Exit position
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="sr-note mt-5">
            No time lock. No treasury administrator controls these positions.
            Full exit redeems all unlocked LP units; the empty NFT remains in
            your wallet.
          </p>
        </Card>
      </div>
      <Card className="sr-panel mt-6">
        <span className="sr-eyebrow">CONNECTED, WITH CLEAR OWNERSHIP</span>
        <h3>Related markets</h3>
        <p className="sr-note">
          ROOM and mSPY also trade in Sonata’s launch market. This is a
          separate, directly seeded DAMM pool—not a migrated or permanently
          locked launch position. Only trades in this pool earn fees for these
          liquidity providers. Creators can now deploy allocated reserves
          through Treasury, or commit a budget to fixed community reward
          claims.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" asChild>
            <Link href={`/onchain?pool=${liquidityMarket.sourceMarket}`}>
              Open launch market
              <ArrowUpRight />
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/capital">
              Treasury
              <ArrowUpRight />
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/rewards">
              Community rewards
              <ArrowUpRight />
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/portfolio">
              Your portfolio
              <ArrowUpRight />
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/activity">
              Transaction receipts
              <ArrowUpRight />
            </Link>
          </Button>
        </div>
      </Card>
    </>
  );
}
