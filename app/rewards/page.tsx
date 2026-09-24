"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "@/app/plain-link";
import { ArrowRight, ArrowUpRight, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TokenName } from "@/app/token-identity";
import { LiveWallet, useLive } from "@/app/onchain/live-session";
import {
  discoverMarkets,
  readTreasury,
  explorer,
  type Market,
  type TreasurySnapshot,
} from "@/lib/treasury/runtime";
import {
  readHolderRewards,
  preparePolicy,
  snapshotHolders,
  prepareHolderRound,
  prepareDelivery,
  type HolderRewards,
  type HolderSnapshot,
} from "@/lib/rewards/holders";
import { prepareRewardClaim } from "@/lib/rewards/runtime";
import { rewardBudget } from "@/lib/rewards/holder-math";
import { formatUnits } from "@/lib/treasury/units";
import { REWARDS_MINT } from "@/lib/treasury/quote-assets";
const short = (s: string) => `${s.slice(0, 5)}…${s.slice(-4)}`;
const time = (n: number) => new Date(n * 1000).toLocaleString();
export default function RewardsPage() {
  const { address, revision, busy, pending, execute } = useLive();
  const [data, setData] = useState<HolderRewards | null>(null),
    [markets, setMarkets] = useState<
      { market: Market; state: TreasurySnapshot }[]
    >([]),
    [loading, setLoading] = useState(true),
    // Markets hidden because the rewards program funds only mSPY.
    [excluded, setExcluded] = useState(0),
    [error, setError] = useState(""),
    [selected, setSelected] = useState(""),
    [share, setShare] = useState("50"),
    [interval, setInterval] = useState("3600"),
    [preview, setPreview] = useState<HolderSnapshot | null>(null),
    [scanning, setScanning] = useState(false),
    [previewError, setPreviewError] = useState("");
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError("");
    setPreview(null);
    try {
      const rewards = await readHolderRewards();
      const rows = [];
      const all = await discoverMarkets();
      // Only mSPY markets can be funded by the rewards program, and never from a
      // Stock Floor: the treasury refuses withdrawals from a floor.
      for (const market of all.filter(
        (m) => m.quoteMint === REWARDS_MINT && (m.mode ?? "duet") === "duet",
      ))
        rows.push({ market, state: await readTreasury(market) });
      if (id === request.current) setExcluded(all.length - rows.length);
      if (id === request.current) {
        setData(rewards);
        setMarkets(rows);
      }
    } catch (e) {
      if (id === request.current) {
        setError(e instanceof Error ? e.message : "Rewards unavailable");
        setData(null);
        setMarkets([]);
      }
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh, revision]);
  const owned = markets.filter((r) => r.market.creator === address),
    source = owned.find((r) => r.market.treasury === selected) ?? owned[0],
    policy = data?.policies.find((p) => p.treasury === source?.market.treasury);
  useEffect(() => {
    setPreview(null);
    setPreviewError("");
    setShare(String((policy?.shareBps ?? 5000) / 100));
    setInterval(String(policy?.intervalSeconds ?? 3600));
  }, [
    source?.market.treasury,
    policy?.shareBps,
    policy?.intervalSeconds,
    address,
  ]);
  const enabled = !!address && !busy && !pending && !loading && !error;
  const rounds = data?.rounds.filter((r) => r.campaign) ?? [];
  const paid = rounds.reduce((s, r) => s + BigInt(r.campaign!.claimed), 0n),
    waiting = rounds.reduce((s, r) => s + BigInt(r.campaign!.remaining), 0n),
    mine = rounds.flatMap((r) =>
      r
        .campaign!.allocations.filter((a) => a.recipient === address)
        .map((a) => ({ ...a, round: r })),
    ),
    earned = mine
      .filter((a) => a.claimed)
      .reduce((s, a) => s + BigInt(a.amount), 0n);
  let budget = 0n,
    budgetError = "";
  if (source && policy) {
    try {
      budget = rewardBudget(
        BigInt(source.state.retained),
        BigInt(policy.checkpoint),
        BigInt(source.state.available),
        policy.shareBps,
      );
    } catch (e) {
      budgetError = e instanceof Error ? e.message : "Reserve unavailable";
    }
  }
  const due =
    !!policy &&
    policy.shareBps > 0 &&
    Date.now() / 1000 >= policy.lastRoundAt + policy.intervalSeconds;
  const scan = async () => {
    if (!source || !policy) return;
    setScanning(true);
    setPreviewError("");
    setPreview(null);
    try {
      setPreview(await snapshotHolders(source.market, policy));
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Snapshot unavailable");
    } finally {
      setScanning(false);
    }
  };
  return (
    <>
      <div className="sr-heading">
        <div>
          <span className="sr-eyebrow">SONATA / HOLDER REWARDS</span>
          <h1>
            Hold the community.
            <br />
            Receive the stock.
          </h1>
          <p>
            Market fees become stock-token payouts, shared in proportion to
            eligible holdings.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>
      <LiveWallet />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 my-6 md:grid-cols-3">
        {[
          ["Paid to holders", paid],
          ["Funded, awaiting delivery", waiting],
          ["Your received rewards", earned],
        ].map(([label, value]) => (
          <Card className="sr-panel" key={String(label)}>
            <span className="sr-eyebrow">{String(label)}</span>
            <h3 className="mt-3">
              {loading ||
              error ||
              (label === "Your received rewards" && !address)
                ? "—"
                : formatUnits(value as bigint)}{" "}
              <TokenName symbol="mSPY" />
            </h3>
            <p className="sr-note mt-2">
              {label === "Your received rewards"
                ? address
                  ? "Delivered to your wallet"
                  : "Connect to see your earnings"
                : "Verified Devnet holder rounds"}
            </p>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 mb-7 md:grid-cols-3">
        {[
          [
            "01",
            "Trading creates fees",
            "Collected fees enter the creator reserve.",
          ],
          [
            "02",
            "Hold to participate",
            "Wallet balances determine each holder’s share.",
          ],
          [
            "03",
            "Receive stock tokens",
            "The operator delivers funded rewards. No staking required.",
          ],
        ].map(([n, title, text]) => (
          <div className="flex gap-3 items-start" key={n}>
            <Badge variant="outline">{n}</Badge>
            <div>
              <strong>{title}</strong>
              <p className="sr-note">{text}</p>
            </div>
          </div>
        ))}
      </div>
      <Tabs defaultValue="holders">
        <TabsList>
          <TabsTrigger value="holders">Holder rewards</TabsTrigger>
          <TabsTrigger value="creator">Creator settings</TabsTrigger>
        </TabsList>
        <TabsContent value="holders" className="space-y-5 mt-5">
          {excluded > 0 && (
            <p className="sr-note" role="status">
              {excluded} market{excluded === 1 ? " is" : "s are"} not shown: holder rewards are paid by a program that currently funds only mSPY markets, and never from a Backed token&apos;s backing, which holders redeem directly.
            </p>
          )}
          <div className="grid gap-5 lg:grid-cols-2">
            {markets.map(({ market: m }) => {
              const p = data?.policies.find((p) => p.treasury === m.treasury),
                rs = rounds.filter((r) => r.policy === p?.address),
                total = rs.reduce(
                  (s, r) => s + BigInt(r.campaign!.claimed),
                  0n,
                );
              return (
                <Card className="sr-panel" key={m.treasury}>
                  <div className="sr-section-top">
                    <h3>
                      <TokenName symbol={m.symbol} />{" "}
                      <ArrowRight size={18} className="inline mx-2" />
                      <TokenName symbol="mSPY" />
                    </h3>
                    <Badge variant="outline">
                      {!p
                        ? "Not enabled"
                        : p.shareBps
                          ? "Holder rewards"
                          : "Paused"}
                    </Badge>
                  </div>
                  <p>
                    {p
                      ? `${p.shareBps / 100}% of new retained fees shared with eligible holders.`
                      : "The creator has not enabled proportional holder rewards."}
                  </p>
                  <div className="sr-detail-row">
                    <span>Paid to holders</span>
                    <strong>{formatUnits(total)} mSPY</strong>
                  </div>
                  <div className="sr-detail-row">
                    <span>Distribution rounds</span>
                    <strong>{rs.length}</strong>
                  </div>
                  <div className="sr-detail-row">
                    <span>Latest funded round</span>
                    <span>
                      {rs[0] ? time(rs[0].createdAt) : "No round yet"}
                    </span>
                  </div>
                  <p className="sr-note mt-3">
                    {p
                      ? `Runs no more often than every ${p.intervalSeconds / 60} ${p.intervalSeconds === 60 ? "minute" : "minutes"}, when new fees and an authorized operator are available.`
                      : "Trading and liquidity remain available."}
                  </p>
                  <Button variant="outline" asChild className="mt-4">
                    <Link href={`/onchain?pool=${m.pool}`}>
                      Open market
                      <ArrowUpRight />
                    </Link>
                  </Button>
                </Card>
              );
            })}
          </div>
          {!loading && !error && !markets.length && (
            <Card className="sr-panel">No markets available yet.</Card>
          )}
          <Card className="sr-panel">
            <h3>Your rewards</h3>
            <p className="sr-note">
              Payouts go to your wallet. You don’t need to enroll or submit an
              address.
            </p>
            {!address ? (
              <p className="mt-4">Connect your wallet to see your rewards.</p>
            ) : loading || error ? (
              <p className="mt-4">
                {loading ? "Reading rewards…" : "Rewards are unavailable."}
              </p>
            ) : !mine.length ? (
              <p className="mt-4">
                No funded holder rewards for this wallet yet.
              </p>
            ) : (
              mine.map((a) => (
                <div
                  className="sr-detail-row flex-wrap gap-3"
                  key={a.round.address + a.index}
                >
                  <span>
                    Round {a.round.number} · {time(a.round.createdAt)}
                  </span>
                  <strong>{formatUnits(a.amount)} mSPY</strong>
                  <Badge variant="outline">
                    {a.claimed ? "Delivered" : "Funded"}
                  </Badge>
                  {!a.claimed && (
                    <Button
                      variant="outline"
                      disabled={!enabled}
                      onClick={() =>
                        void execute(() =>
                          prepareDelivery(
                            address,
                            a.round.campaign!.address,
                            a.index,
                          ),
                        )
                      }
                    >
                      Receive now
                    </Button>
                  )}
                </div>
              ))
            )}
          </Card>
          <Card className="sr-panel">
            <h3>Distribution history</h3>
            <p className="sr-note">
              Funded budgets and delivery status, recorded on Solana.
            </p>
            {!loading && !error && !rounds.length && (
              <p className="mt-4">
                The first funded holder round will appear here.
              </p>
            )}
            {rounds.map((r) => (
              <div className="border-t py-4 mt-3" key={r.address}>
                <div className="sr-detail-row flex-wrap gap-3">
                  <strong>Round {r.number}</strong>
                  <span>{time(r.createdAt)}</span>
                  <Badge variant="outline">
                    {r.campaign!.remaining === "0"
                      ? "Delivered"
                      : "Delivery pending"}
                  </Badge>
                </div>
                <p>
                  {formatUnits(r.campaign!.claimed)} /{" "}
                  {formatUnits(r.campaign!.funded)} <TokenName symbol="mSPY" />{" "}
                  delivered · {r.campaign!.allocations.length} payouts
                </p>
                <details className="mt-3">
                  <summary className="cursor-pointer">
                    View holders &amp; onchain record
                  </summary>
                  <p className="sr-note mt-3">
                    Snapshot slot {r.slot}. Creator-attested wallet snapshot;
                    balances are calculated offchain.
                  </p>
                  <a
                    className="sr-text-link"
                    href={explorer("address", r.address)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View round on explorer ↗
                  </a>
                  {r.campaign!.allocations.map((a) => (
                    <div
                      className="sr-detail-row flex-wrap gap-3"
                      key={a.index}
                    >
                      <a
                        href={explorer("address", a.recipient)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {short(a.recipient)}
                      </a>
                      <span>
                        {formatUnits(a.amount)} mSPY ·{" "}
                        {a.claimed ? "Delivered" : "Pending"}
                      </span>
                      {!a.claimed && (
                        <Button
                          variant="outline"
                          disabled={!enabled}
                          onClick={() =>
                            void execute(() =>
                              prepareDelivery(
                                address,
                                r.campaign!.address,
                                a.index,
                              ),
                            )
                          }
                        >
                          Deliver
                        </Button>
                      )}
                    </div>
                  ))}
                </details>
              </div>
            ))}
          </Card>
          <details>
            <summary className="cursor-pointer">
              Eligibility &amp; distribution rules
            </summary>
            <p className="sr-note mt-3">
              Positive balances in unfrozen token accounts owned by signing
              wallets qualify at the recorded snapshot. Creator and
              program-owned accounts are excluded. Multiple accounts belonging
              to one wallet are combined. Amounts are proportional, with
              deterministic rounding to whole token units. Buying after a
              snapshot does not earn that round. There is no guaranteed payout
              interval or return. The current Devnet round supports up to eight
              payable wallets and stops rather than omitting holders if that
              limit is exceeded.
            </p>
          </details>
          {!!data?.legacy.some((c) =>
            c.allocations.some((a) => a.recipient === address && !a.claimed),
          ) && (
            <details>
              <summary className="cursor-pointer">
                Earlier one-off allocations
              </summary>
              <p className="sr-note">
                Existing funded grants remain recoverable; they are excluded
                from holder-reward totals.
              </p>
              {data.legacy.flatMap((c) =>
                c.allocations
                  .filter((a) => a.recipient === address && !a.claimed)
                  .map((a) => (
                    <Button
                      key={c.address + a.index}
                      variant="outline"
                      disabled={!enabled}
                      onClick={() =>
                        void execute(() =>
                          prepareRewardClaim(address, c.address, a.index),
                        )
                      }
                    >
                      Claim {formatUnits(a.amount)} mSPY
                    </Button>
                  )),
              )}
            </details>
          )}
        </TabsContent>
        <TabsContent value="creator" className="mt-5">
          <Card className="sr-panel">
            <h3>Reward settings</h3>
            <p>
              Choose the policy. Sonata reads balances and calculates
              payouts.
            </p>
            {!address ? (
              <p className="mt-4">
                Connect your creator wallet to configure rewards.
              </p>
            ) : !source ? (
              <p className="mt-4">
                {loading
                  ? "Reading markets…"
                  : "This wallet does not own a registered market."}
              </p>
            ) : (
              <div className="space-y-5 mt-5">
                <div>
                  <Label htmlFor="reward-market">Market</Label>
                  <Select
                    value={source.market.treasury}
                    onValueChange={setSelected}
                  >
                    <SelectTrigger id="reward-market">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {owned.map((r) => (
                        <SelectItem
                          key={r.market.treasury}
                          value={r.market.treasury}
                        >
                          <TokenName symbol={r.market.symbol} />
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-5 md:grid-cols-2">
                  <div>
                    <Label htmlFor="reward-share">
                      Share of new retained fees
                    </Label>
                    <Select value={share} onValueChange={setShare}>
                      <SelectTrigger id="reward-share">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["0", "25", "50", "75", "100"].map((n) => (
                          <SelectItem key={n} value={n}>
                            {n === "0" ? "Paused" : `${n}% to holders`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="reward-interval">
                      Minimum time between rounds
                    </Label>
                    <Select value={interval} onValueChange={setInterval}>
                      <SelectTrigger id="reward-interval">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[
                          ["60", "Every minute · Devnet testing"],
                          ["3600", "Every hour"],
                          ["86400", "Every day"],
                        ].map(([v, l]) => (
                          <SelectItem key={v} value={v}>
                            {l}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <p className="sr-note">
                  The remaining {100 - Number(share)}% stays in your reserve.
                  This applies after your treasury’s existing fee split. Saving
                  starts from newly retained fees; it does not distribute the
                  existing reserve. Operator execution requires your authorized
                  signer; saving alone does not start a background service.
                </p>
                <Button
                  disabled={!enabled || (!policy && share === "0")}
                  onClick={() =>
                    void execute(() =>
                      preparePolicy(
                        address,
                        source.market,
                        Number(share) * 100,
                        Number(interval),
                        !!policy,
                      ),
                    )
                  }
                >
                  {policy ? "Save reward policy" : "Enable holder rewards"}
                </Button>
                {policy && (
                  <div className="border-t pt-5 space-y-4">
                    <h3>Next holder round</h3>
                    <div className="sr-detail-row">
                      <span>New reward budget</span>
                      <strong>
                        {formatUnits(budget)} <TokenName symbol="mSPY" />
                      </strong>
                    </div>
                    <p className="sr-note">
                      {!policy.shareBps
                        ? "Rewards are paused."
                        : !due
                          ? `Next eligible round after ${time(policy.lastRoundAt + policy.intervalSeconds)}.`
                          : budget === 0n
                            ? "Waiting for new collected and retained trading fees."
                            : "Ready to snapshot holders and fund the next round."}
                    </p>
                    <Link
                      className="sr-text-link"
                      href={`/onchain?pool=${source.market.pool}`}
                    >
                      Collect &amp; allocate market fees →
                    </Link>
                    {(budgetError || previewError) && (
                      <Alert variant="destructive">
                        <AlertDescription>
                          {budgetError || previewError}
                        </AlertDescription>
                      </Alert>
                    )}
                    <Button
                      variant="outline"
                      disabled={
                        !enabled ||
                        !due ||
                        budget <= 0n ||
                        scanning ||
                        !!budgetError
                      }
                      onClick={() => void scan()}
                    >
                      {scanning
                        ? "Reading all holder balances…"
                        : "Preview holder distribution"}
                    </Button>
                    {preview && (
                      <div className="space-y-3">
                        <p>
                          <strong>{preview.payouts.length} payouts</strong> ·{" "}
                          {formatUnits(preview.budget)} mSPY · snapshot slot{" "}
                          {preview.slot}
                        </p>
                        {preview.shares.map((s) => (
                          <div
                            className="sr-detail-row flex-wrap gap-3"
                            key={s.recipient}
                          >
                            <span>{short(s.recipient)}</span>
                            <span>
                              {formatUnits(
                                s.balance,
                                source.market.baseDecimals,
                              )}{" "}
                              {source.market.symbol}
                            </span>
                            <strong>{formatUnits(s.amount)} mSPY</strong>
                          </div>
                        ))}
                        <Button
                          disabled={!enabled}
                          onClick={() =>
                            void execute(() =>
                              prepareHolderRound(
                                address,
                                source.market,
                                preview,
                              ),
                            )
                          }
                        >
                          Review &amp; fund holder round
                        </Button>
                        <p className="sr-note">
                          Balances are checked again before review. Once funded,
                          recipients and amounts cannot change. The operator can
                          deliver payouts without holder signatures.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
