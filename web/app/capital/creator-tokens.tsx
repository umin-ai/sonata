"use client";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import Link from "@/app/plain-link";
import { TokenName } from "@/app/token-identity";
import { TokenImage, useTokenProfile } from "@/app/token-profile-view";
import { useLive } from "@/app/onchain/live-session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { findCreatorPosition, prepareCreatorClaim, type CreatorPositionRead } from "@/lib/liquidity/creator-position";
import { prepareReserveDeployment } from "@/lib/liquidity/runtime";
import { tokenEarnings, type TokenEarnings } from "@/lib/treasury/creator-earnings";
import { BOT_SHARE_LABEL, launchedAs } from "@/lib/treasury/fee-split";
import { formatProgress } from "@/lib/treasury/graduation";
import { REWARDS_MINT, quoteSymbolOf } from "@/lib/treasury/quote-assets";
import {
  connection,
  isRewardMarket,
  prepareTreasury,
  readTreasury,
  type Market,
  type TreasurySnapshot,
} from "@/lib/treasury/runtime";
import { listMarkets } from "@/app/onchain/markets-client";
import { formatUnits } from "@/lib/treasury/units";
import { usePayoutLine } from "@/app/onchain/payout-timer";

export type CreatorToken = {
  market: Market;
  stock: string;
  state?: TreasurySnapshot;
  /** The creator's locked pool half after graduation; null if unreadable or not held. */
  position?: CreatorPositionRead | null;
  earnings?: TokenEarnings;
  error?: string;
};

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const shortKey = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

// Reads a few markets at a time, so a creator with many tokens does not trip
// Devnet's rate limits; `each` hears about every result as it lands.
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, each: (i: number, r: R) => void) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        each(i, await fn(items[i]));
      }
    }),
  );
}

async function readToken(market: Market, wallet: string): Promise<CreatorToken> {
  const stock = quoteSymbolOf(market.quoteMint);
  try {
    const state = await readTreasury(market);
    const position =
      state.migrated && market.creator === wallet
        ? await findCreatorPosition(connection, market).catch(() => null)
        : null;
    const p = position?.position;
    const earnings = tokenEarnings(
      {
        mode: state.mode,
        stock,
        creator: market.creator,
        payoutOwner: market.payoutOwner,
        reward: isRewardMarket(market),
        paid: BigInt(state.paid),
        uncollected: state.poolFees && "error" in state.poolFees ? 0n : BigInt(state.uncollected),
        unallocated: BigInt(state.unallocated),
        available: BigInt(state.available),
        position: p ? { unclaimed: BigInt(p.unclaimedB), claimed: BigInt(p.claimedB) } : null,
      },
      wallet,
    );
    return { market, stock, state, position, earnings };
  } catch (e) {
    return { market, stock, error: message(e, "Market unavailable") };
  }
}

/** Every token `address` launched or is paid by, re-read after each confirmed transaction. */
export function useCreatorTokens(address: string) {
  const { revision } = useLive();
  const [tick, setTick] = useState(0);
  const key = address ? `${address}:${revision}:${tick}` : "";
  const [read, setRead] = useState<{ key: string; tokens: CreatorToken[]; done: boolean; error?: string } | null>(null);
  // The list from the server's snapshot on the first read; from the chain after a transaction or a refresh.
  const fresh = revision > 0 || tick > 0;
  useEffect(() => {
    if (!key || !address) return;
    let active = true;
    listMarkets({ fresh })
      .then((all) => all.filter((m) => m.creator === address || m.payoutOwner === address))
      .then((mine) => {
        if (!active) return;
        // The cards show at once; each fills in when its own read lands. A re-read
        // keeps the last numbers on screen until the new ones arrive.
        setRead((last) => ({
          key,
          done: false,
          tokens: mine.map(
            (market) =>
              last?.tokens.find((t) => t.market.treasury === market.treasury) ?? {
                market,
                stock: quoteSymbolOf(market.quoteMint),
              },
          ),
        }));
        return mapLimited(
          mine,
          3,
          (m) => readToken(m, address),
          (i, token) =>
            active && setRead((r) => (r?.key === key ? { ...r, tokens: r.tokens.map((t, j) => (j === i ? token : t)) } : r)),
        );
      })
      .then(
        () => active && setRead((r) => (r?.key === key ? { ...r, done: true } : { key, tokens: [], done: true })),
        (e) =>
          active &&
          setRead((last) => ({ key, tokens: last?.tokens ?? [], done: true, error: message(e, "Markets unavailable") })),
      );
    return () => {
      active = false;
    };
  }, [key, address, fresh]);
  const same = read?.key.startsWith(`${address}:`) ? read : null;
  return {
    tokens: same?.tokens ?? [],
    error: read?.key === key ? read.error : undefined,
    /** Still reading this wallet's markets (some cards may already show). */
    loading: !!key && !(read?.key === key && read.done),
    /** Nothing known yet: the list of markets itself is still loading. */
    listing: !!key && !same,
    refresh: () => setTick((t) => t + 1),
  };
}

// The token's type, as chosen at launch.
function typeLabel(t: CreatorToken) {
  return launchedAs(t.state?.mode ?? t.market.mode ?? "standard", isRewardMarket(t.market), t.market.feeModel);
}

function Line({ label, value, action }: { label: string; value: ReactNode; action?: ReactNode }) {
  return (
    <div className="sr-detail-row creator-line">
      <span>{label}</span>
      <strong>{value}</strong>
      {action && <span className="creator-line-action">{action}</span>}
    </div>
  );
}
const Stock = ({ atoms, stock }: { atoms: bigint | string; stock: string }) => (
  <>
    {formatUnits(atoms)} <TokenName symbol={stock} size={18} />
  </>
);

/**
 * One launched token: what it has paid `viewer` (the wallet whose page this
 * is), and a button for everything waiting. Anyone can collect and pay out;
 * only the connected creator can claim, withdraw or deploy their own share.
 */
export function TokenCard({ token: t, viewer }: { token: CreatorToken; viewer: string }) {
  const { address, busy, pending, execute } = useLive();
  const profile = useTokenProfile(t.market.uri);
  const [withdraw, setWithdraw] = useState("");
  const [deploy, setDeploy] = useState("");
  const enabled = !!address && !busy && !pending;
  const s = t.state,
    e = t.earnings,
    m = t.market;
  const reward = isRewardMarket(m);
  const next = usePayoutLine(
    s ? { uncollected: BigInt(s.uncollected), unallocated: BigInt(s.unallocated), lastClaimTs: s.lastClaimTs } : null,
  );
  const theirs = m.creator === viewer,
    mine = theirs && m.creator === address;
  return (
    <Card className="sr-panel creator-token">
      <div className="creator-token-head">
        <TokenImage profile={profile} symbol={m.symbol} size={32} />
        <span className="sr-token-name">
          <b>{m.symbol}</b>
        </span>
        <span className="sr-pair-divider">/</span>
        <TokenName symbol={t.stock} size={20} />
        <Badge variant="outline">
          {!s ? "—" : s.migrated ? "Graduated" : `Curve ${formatProgress(s.graduationBps)}`}
        </Badge>
        <Link className="sr-text-link creator-token-open" href={`/onchain?pool=${m.pool}`}>
          Open <ArrowUpRight size={14} />
        </Link>
      </div>
      {t.error || !s || !e ? (
        <Line label="Status" value={t.error ?? "Reading…"} />
      ) : (
        <div>
          <Line label="Launched as" value={typeLabel(t)} />
          <Line
            label="Your share"
            value={
              reward
                ? `${BOT_SHARE_LABEL[m.feeModel ?? ""] ?? "Holders"} · via Sonata's bot`
                : e.sharePercent
                  ? `${e.sharePercent}% of each fee${m.payoutOwner === viewer ? "" : ` · paid to ${shortKey(m.payoutOwner)}`}`
                  : `Paid to ${shortKey(m.payoutOwner)}`
            }
          />
          {!reward && m.payoutOwner === viewer && <Line label="Paid out" value={<Stock atoms={e.paidToYou} stock={t.stock} />} />}
          <Line
            label="Waiting to pay out"
            value={
              <>
                <Stock atoms={e.waiting} stock={t.stock} />
                {/* Only when it differs: "Your share" above already says 100%. */}
                {e.yourWaiting > 0n && e.yourWaiting < e.waiting && (
                  <small> · {formatUnits(e.yourWaiting)} to this wallet</small>
                )}
              </>
            }
            action={
              e.waiting > 0n &&
              (next.late ? (
                <Button size="sm" variant="outline" disabled={!enabled} onClick={() => void execute(() => prepareTreasury("sync", address, m))}>
                  Bot late? Send now
                </Button>
              ) : (
                <small className="creator-next">Paid out {next.text}</small>
              ))
            }
          />
          {s.migrated && theirs && s.creatorPoolPercent > 0 && (
            <Line
              label={`Pool share · ${s.creatorPoolPercent}%`}
              value={
                t.position?.position ? (
                  <>
                    <Stock atoms={e.poolToClaim} stock={t.stock} /> to claim
                    {e.poolClaimed > 0n && <small> · {formatUnits(e.poolClaimed)} claimed</small>}
                  </>
                ) : t.position === null ? (
                  "Unavailable"
                ) : (
                  "Position NFT not in the creator's wallet"
                )
              }
              action={
                mine && e.poolToClaim > 0n && (
                  <Button size="sm" disabled={!enabled} onClick={() => void execute(() => prepareCreatorClaim(address, m))}>
                    Claim
                  </Button>
                )
              }
            />
          )}
          {s.mode === "duet" && theirs && (
            <>
              <Line label="Reserve" value={<Stock atoms={e.reserve} stock={t.stock} />} />
              {mine && e.reserve > 0n && (
                <div className="creator-reserve">
                  <div>
                    <Input
                      aria-label={`${t.stock} to withdraw`}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={withdraw}
                      onChange={(ev) => setWithdraw(ev.target.value.replace(/[^0-9.]/g, ""))}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!enabled || !withdraw}
                      onClick={() => void execute(() => prepareTreasury("withdraw", address, m, withdraw))}
                    >
                      Withdraw
                    </Button>
                  </div>
                  {m.quoteMint === REWARDS_MINT && (
                    <div>
                      <Input
                        aria-label={`${t.stock} to put into the ROOM / ${t.stock} pool`}
                        inputMode="decimal"
                        placeholder="0.00"
                        value={deploy}
                        onChange={(ev) => setDeploy(ev.target.value.replace(/[^0-9.]/g, ""))}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!enabled || !deploy}
                        onClick={() => void execute(() => prepareReserveDeployment(address, m, deploy))}
                      >
                        Put into ROOM / {t.stock} pool
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
