"use client";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import Link from "@/app/plain-link";
import { TokenName } from "@/app/token-identity";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { feeSplit, redeemed, BOT_SHARE_LABEL } from "@/lib/treasury/fee-split";
import { REWARDS_MINT } from "@/lib/treasury/quote-assets";
import {
  explorer,
  hasFloor,
  isRewardMarket,
  prepareTreasury,
  type Market,
  type TreasurySnapshot,
} from "@/lib/treasury/runtime";
import { nextRunText, sinceText } from "@/lib/treasury/payout-timing";
import { formatUnits } from "@/lib/treasury/units";
import { useLive } from "./live-session";

// What Sonata's payout bot has done for a reward token, as the indexer recorded it.
type BotPayouts = {
  paid: string;
  payouts: number;
  recipientsLast: number;
  lastPaidAt: number | null;
  feeModel?: string;
  burned?: string;
  lastBuyAt?: number | null;
  winners?: { trader: string; amount: string; rank?: number }[];
  lastRoundAt?: number | null;
  status?: string;
  recipients?: { wallet: string; weight: number; paid?: string }[];
  splitError?: string;
};

const shortKey = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

function Row({ label, children, tone }: { label: ReactNode; children: ReactNode; tone?: "warn" }) {
  return (
    <div className="sr-detail-row" data-tone={tone}>
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}
function Stock({ atoms, quote }: { atoms: string | bigint | undefined; quote: string }) {
  return (
    <>
      {atoms === undefined ? "—" : formatUnits(atoms)} <TokenName symbol={quote} />
    </>
  );
}
function AddressLink({ address }: { address: string }) {
  return (
    <a className="sr-text-link" href={explorer("address", address)} target="_blank" rel="noreferrer">
      {shortKey(address)} <ArrowUpRight size={13} />
    </a>
  );
}

function useBotPayouts(pool: string, active: boolean, revision: number) {
  const [paid, setPaid] = useState<BotPayouts | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    fetch(`/api/index/rewards?pool=${pool}`)
      .then((r) => (r.ok ? (r.json() as Promise<BotPayouts>) : null))
      .then((d) => live && d && setPaid(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pool, active, revision]);
  return paid;
}

/** The Fees & treasury tab: what the market has earned, where it goes, and what is held. */
export function FeesView({
  market,
  data,
  quote: q,
  feeModel: profileModel,
}: {
  market: Market;
  data: TreasurySnapshot | null;
  quote: string;
  feeModel?: string;
}) {
  const { address, busy, pending, revision, execute } = useLive();
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const reward = isRewardMarket(market);
  const bot = useBotPayouts(market.pool, reward, revision);
  const mode = data?.mode ?? market.mode ?? "standard";
  const model = bot?.feeModel ?? profileModel ?? market.feeModel ?? "holders";
  const totals = data
    ? { paid: BigInt(data.paid), retained: BigInt(data.retained), withdrawn: BigInt(data.withdrawn) }
    : undefined;
  const shares = feeSplit(mode, { reward, feeModel: model, totals });
  const enabled = !!address && !busy && !pending && !!data;
  const poolError = data?.poolFees && "error" in data.poolFees ? data.poolFees.error : null;
  const ready = data ? BigInt(data.uncollected) : 0n,
    waiting = data ? BigInt(data.unallocated) : 0n;

  return (
    <>
      <div className="sr-community-layout fees-layout">
        <Card className="sr-panel">
          <span className="sr-eyebrow">FEES</span>
          <h3>Trading fees</h3>
          <div>
            <Row label="Earned in">
              {!data
                ? "—"
                : data.migrated
                  ? "Meteora pool · Sonata's locked half"
                  : `Bonding curve · ${Number((data.tradingFeeBps / 100).toFixed(2))}% fee`}
            </Row>
            <Row label="Ready to collect" tone={poolError ? "warn" : undefined}>
              {poolError ? "Can't read the pool right now" : <Stock atoms={data?.uncollected} quote={q} />}
            </Row>
            {waiting > 0n && (
              <Row label="Collected, not paid yet">
                <Stock atoms={waiting} quote={q} />
              </Row>
            )}
            <Row label="Collected so far">
              <Stock atoms={data?.claimed} quote={q} />
            </Row>
            <Row label="Last collected">
              {!data ? "—" : data.lastClaimTs > 0 ? sinceText(data.lastClaimTs, data.fetchedAt) : "Not yet"}
            </Row>
            <Row label="Auto payout">{data ? `Every 15 min · next ${nextRunText(data.fetchedAt)}` : "Every 15 min"}</Row>
            <Row label="Meteora's cut">20% of each fee</Row>
          </div>
          <Button
            disabled={!enabled || (ready <= 0n && waiting <= 0n) || !!poolError}
            onClick={() => void execute(() => prepareTreasury("sync", address, market))}
          >
            Collect &amp; pay out now
          </Button>
          <p className="sr-note fees-hint">Anyone can run it · you pay only the network fee</p>
        </Card>

        <Card className="sr-panel">
          <span className="sr-eyebrow">WHERE FEES GO</span>
          <h3>Fee split</h3>
          <div>
            {shares.map((s) => (
              <Row
                key={s.to}
                label={
                  s.to === "creator" ? (
                    <>
                      Creator · <AddressLink address={market.payoutOwner} />
                    </>
                  ) : s.to === "bot" ? (
                    `${s.label} · via Sonata's bot`
                  ) : (
                    s.label
                  )
                }
              >
                {s.percent}% · <Stock atoms={s.received} quote={q} />
              </Row>
            ))}
            <Row label="Split">Fixed at launch</Row>
            {data?.migrated && data.creatorPoolPercent > 0 && (
              <Row label="Creator's pool share">{data.creatorPoolPercent}% · creator claims it on Trade</Row>
            )}
          </div>
        </Card>
      </div>

      {reward ? (
        <Card className="sr-panel">
          <span className="sr-eyebrow">PAID BY SONATA&apos;S BOT</span>
          <h3>{BOT_SHARE_LABEL[model] ?? "Holder rewards"}</h3>
          <div>
            <Row label="Who gets it">
              {model === "buyback"
                ? `Nobody: it buys ${market.symbol} and burns it`
                : model === "topBuyers"
                  ? "Each round's 3 biggest net buyers · 50/30/20%"
                  : model === "lpFarm"
                    ? bot?.status === "lps"
                      ? "Liquidity providers in the Meteora pool"
                      : "Holders now · liquidity providers after graduation"
                    : model === "split"
                      ? "The creator's chosen wallets, by share"
                      : model === "diamond"
                        ? "Holders · up to 3× for holding longer"
                        : "Holders of at least 0.01% of the supply"}
            </Row>
            {model !== "buyback" && model !== "split" && (
              <Row label="Left out">{model === "topBuyers" ? "The creator and Sonata" : "The creator's wallet"}</Row>
            )}
            {model === "buyback" && (
              <Row label="Burned">
                {bot?.burned ? formatUnits(bot.burned, 6) : "—"} {market.symbol}
              </Row>
            )}
            <Row label={model === "buyback" ? "Spent on buybacks" : "Paid out"}>
              <Stock atoms={bot?.paid} quote={q} />
            </Row>
            <Row label={model === "buyback" ? "Last buy" : model === "topBuyers" ? "Last round" : "Last payout"}>
              {(() => {
                const t = model === "buyback" ? (bot?.lastBuyAt ?? bot?.lastPaidAt) : model === "topBuyers" ? (bot?.lastRoundAt ?? bot?.lastPaidAt) : bot?.lastPaidAt;
                if (!t) return "Not yet";
                const when = sinceText(t, data?.fetchedAt ?? t * 1000);
                return model === "holders" || model === "diamond" ? `${when} · ${bot?.recipientsLast ?? 0} holders` : when;
              })()}
            </Row>
            {model === "split" && bot?.splitError && (
              <Row label="Status" tone="warn">
                Can&apos;t pay ({bot.splitError}) · held, not sent elsewhere
              </Row>
            )}
          </div>
          {model === "topBuyers" && !!bot?.winners?.length && (
            <div className="bot-list">
              {bot.winners.map((w, i) => (
                <Row key={w.trader} label={`${["1st", "2nd", "3rd"][(w.rank ?? i + 1) - 1] ?? `${w.rank ?? i + 1}th`} · ${shortKey(w.trader)}`}>
                  <Stock atoms={w.amount} quote={q} />
                </Row>
              ))}
            </div>
          )}
          {model === "split" && !!bot?.recipients?.length && (
            <div className="bot-list">
              {bot.recipients.map((r) => (
                <Row
                  key={r.wallet}
                  label={`${shortKey(r.wallet)} · ${Math.round((r.weight / bot.recipients!.reduce((t, x) => t + x.weight, 0)) * 100)}%`}
                >
                  {r.paid ? <Stock atoms={r.paid} quote={q} /> : "—"}
                </Row>
              ))}
            </div>
          )}
        </Card>
      ) : hasFloor(mode) ? (
        <Card className="sr-panel">
          <span className="sr-eyebrow">BACKING</span>
          <h3>Held for holders</h3>
          <div>
            <Row label="Backing now">
              <Stock atoms={data?.floor} quote={q} />
            </Row>
            <Row label="Added so far">
              <Stock atoms={shares.find((s) => s.to === "backing")?.received} quote={q} />
            </Row>
            <Row label="Redeemed by holders">
              <Stock atoms={totals ? redeemed(mode, totals) : undefined} quote={q} />
            </Row>
            <Row label="Creator can withdraw">Never</Row>
            <Row label="Redeem">Burn {market.symbol} on Trade</Row>
          </div>
        </Card>
      ) : mode === "duet" ? (
        <Card className="sr-panel">
          <span className="sr-eyebrow">CREATOR RESERVE</span>
          <h3>Reserve</h3>
          <div>
            <Row label="Reserve now">
              <Stock atoms={data?.available} quote={q} />
            </Row>
            <Row label="Added so far">
              <Stock atoms={data?.retained} quote={q} />
            </Row>
            <Row label="Withdrawn">
              <Stock atoms={data?.withdrawn} quote={q} />
            </Row>
            <Row label="Who can withdraw">
              <>
                Creator only · <AddressLink address={market.creator} />
              </>
            </Row>
            <Row label="Holders can redeem">No</Row>
          </div>
          <div className="fees-actions">
            {market.quoteMint === REWARDS_MINT && address === market.creator && (
              <Button asChild variant="outline">
                <Link href="/capital">
                  Put into the ROOM / {q} pool <ArrowUpRight />
                </Link>
              </Button>
            )}
            {address === market.creator && (
              <div className="fees-withdraw">
                <Input
                  aria-label={`Amount of ${q} to withdraw`}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                />
                <Button
                  disabled={!enabled || !data || BigInt(data.available) === 0n || !withdrawAmount}
                  onClick={() => void execute(() => prepareTreasury("withdraw", address, market, withdrawAmount))}
                >
                  Withdraw
                </Button>
              </div>
            )}
          </div>
        </Card>
      ) : null}
    </>
  );
}
