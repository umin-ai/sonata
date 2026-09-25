"use client";
// First: token-profile-view reaches SPL Token (through lib/split-rules.mjs),
// which needs Buffer while its module loads.
import "@/lib/stockroom/polyfills.mjs";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Gift, RefreshCw, ShieldCheck } from "lucide-react";
import Link from "@/app/plain-link";
import { TokenName } from "@/app/token-identity";
import { TokenImage, loadProfile, useTokenProfile } from "@/app/token-profile-view";
import { MarketBadges } from "@/app/onchain/market-badges";
import { LiveWallet, useLive } from "@/app/onchain/live-session";
import { WalletConnectButton } from "@/app/onchain/wallet-connect";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  discoverMarkets,
  explorer,
  hasFloor,
  isRewardMarket,
  readMarketFacts,
  type Market,
  type MarketFacts,
} from "@/lib/treasury/runtime";
import { formatUnits } from "@/lib/treasury/units";
import { quoteSymbolOf } from "@/lib/treasury/quote-assets";
import { AIRDROP_PERCENT } from "@/lib/treasury/dbc-preview";
import { PAYOUT_BOT_V2 } from "@/lib/features";
import {
  botModel,
  kindName,
  listsModel,
  paysWhom,
  readMarketPayouts,
  readTokenBalances,
  readWalletPayouts,
  sinceText,
  stockTotals,
  walletBacking,
  type MarketPayouts,
  type WalletPayout,
} from "@/lib/rewards/overview";
import type { HolderRewards } from "@/lib/rewards/holders";
import type { TokenProfile } from "@/lib/token-profile";

// Rewards: what Sonata's payout bot pays. Reward tokens pay their holders from
// the creator's share of every trade (and, once the new bot runs, the fee
// modules and the graduation airdrop); Backed tokens hold a backing any holder
// can burn tokens for. Standard tokens pay only their creator, so they are not
// listed. Payouts come from the trade indexer's ledger; backing from chain.

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const marketHref = (m: Market) => `/onchain?pool=${m.pool}`;
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const bySymbol = (a: Market, b: Market) => a.symbol.localeCompare(b.symbol) || (a.pool < b.pool ? -1 : 1);
const NONE: Market[] = [];

type Overview = { markets: Market[]; facts: Map<string, MarketFacts>; factsError?: string };

// Every market with its backing and launch extras. The last read stays on
// screen while a refresh loads.
function useOverview(key: string) {
  const [read, setRead] = useState<{ key: string; data?: Overview; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    (async (): Promise<Overview> => {
      const markets = await discoverMarkets();
      try {
        return { markets, facts: await readMarketFacts(markets, { configs: PAYOUT_BOT_V2 }) };
      } catch (e) {
        return { markets, facts: new Map(), factsError: message(e, "Backing unavailable.") };
      }
    })().then(
      (data) => active && setRead({ key, data }),
      (e) => active && setRead((last) => ({ key, data: last?.data, error: message(e, "Markets unavailable.") })),
    );
    return () => {
      active = false;
    };
  }, [key]);
  return { data: read?.data, error: read?.key === key ? read.error : undefined, loading: read?.key !== key };
}

// Each market's fee model from its token metadata, once all are read.
function useFeeModels(markets: Market[]) {
  const [read, setRead] = useState<{ markets: Market[]; models: Map<string, string | undefined> } | null>(null);
  useEffect(() => {
    let active = true;
    Promise.all(
      markets.map(async (m) => [m.pool, m.uri ? (await loadProfile(m.uri))?.feeModel : undefined] as const),
    ).then((entries) => active && setRead({ markets, models: new Map(entries) }));
    return () => {
      active = false;
    };
  }, [markets]);
  return read?.markets === markets ? read.models : undefined;
}

// What the indexer has recorded for one market; kept while a refresh loads.
function useMarketPayouts(pool: string | null, refresh: string) {
  const key = `${pool}:${refresh}`;
  const [read, setRead] = useState<{ pool: string; key: string; data: MarketPayouts | null; readAt: number } | null>(null);
  useEffect(() => {
    if (!pool) return;
    let active = true;
    void readMarketPayouts(pool).then((data) => active && setRead({ pool, key, data, readAt: Date.now() }));
    return () => {
      active = false;
    };
  }, [pool, key]);
  const current = read && read.pool === pool ? read : null;
  return { data: current?.data ?? null, readAt: current?.readAt ?? 0, loaded: !!current };
}

// The connected wallet's payouts (indexer) and base-token balances (chain).
function useWallet(address: string, refresh: string) {
  const key = `${address}:${refresh}`;
  type Read = { address: string; key: string; readAt: number; rows?: WalletPayout[]; error?: string };
  const [payouts, setPayouts] = useState<Read | null>(null);
  const [balances, setBalances] = useState<{ address: string; key: string; value?: Map<string, bigint>; error?: string } | null>(null);
  useEffect(() => {
    if (!address) return;
    let active = true;
    readWalletPayouts(address).then(
      (rows) => active && setPayouts({ address, key, rows, readAt: Date.now() }),
      (e) => active && setPayouts({ address, key, readAt: Date.now(), error: message(e, "Payout history is unavailable right now.") }),
    );
    readTokenBalances(address).then(
      (value) => active && setBalances({ address, key, value }),
      (e) => active && setBalances({ address, key, error: message(e, "Balances unavailable.") }),
    );
    return () => {
      active = false;
    };
  }, [address, key]);
  const p = payouts?.address === address ? payouts : null,
    b = balances?.address === address ? balances : null;
  return {
    payouts: p?.rows,
    payoutsError: p?.error,
    readAt: p?.readAt ?? 0,
    balances: b?.value,
    balancesError: b?.error,
  };
}

function PairLabel({ market, profile }: { market: Market; profile: TokenProfile | null }) {
  return (
    <span className="pool-pair">
      {profile?.image ? (
        <>
          <TokenImage profile={profile} symbol={market.symbol} size={26} />
          <b>{market.symbol}</b>
        </>
      ) : (
        <TokenName symbol={market.symbol} size={26} />
      )}
      <span className="sr-pair-divider">/</span>
      <TokenName symbol={quoteSymbolOf(market.quoteMint)} size={20} />
    </span>
  );
}

function airdropText(a: MarketPayouts["airdrop"] | undefined, readAt: number) {
  if (a?.status === "sent") return `Sent to ${a.recipients} holders${a.sentAt ? ` ${sinceText(a.sentAt, readAt)}` : ""}`;
  if (a?.amount) return "Being sent now";
  return "At graduation";
}

// A market that pays people other than its creator: a Reward token (holder
// rewards or, once the new bot runs, a fee module) and/or a graduation airdrop.
function PayingRow({ market: m, facts, refresh }: { market: Market; facts?: MarketFacts; refresh: string }) {
  const profile = useTokenProfile(m.uri);
  const bot = useMarketPayouts(m.pool, refresh);
  const quote = quoteSymbolOf(m.quoteMint);
  const model = isRewardMarket(m) ? botModel(bot.data?.feeModel, profile?.feeModel, m.feeModel) : null;
  const airdrop = PAYOUT_BOT_V2 && !!facts?.airdrop;
  const last = bot.data?.lastPaidAt ? sinceText(bot.data.lastPaidAt, bot.readAt) : bot.data ? "Not yet" : "—";
  return (
    <li className="reward-row">
      <div className="reward-row-head">
        <PairLabel market={m} profile={profile} />
        <MarketBadges
          market={m}
          data={{ airdrop, volatilityFee: !!facts?.volatilityFee, mode: m.mode, floor: facts?.floor }}
          feeModel={model ?? undefined}
          quote={quote}
        />
      </div>
      {model && (
        <dl className="reward-facts">
          <div>
            <dt>Pays</dt>
            <dd>{paysWhom(model, bot.data?.status)}</dd>
          </div>
          <div>
            <dt>{model === "buyback" ? "Spent" : "Paid"}</dt>
            <dd>{bot.data ? `${formatUnits(bot.data.paid, m.quoteDecimals)} ${quote}` : "—"}</dd>
          </div>
          <div>
            <dt>{model === "buyback" ? "Last buy" : "Last payout"}</dt>
            <dd>{last}</dd>
          </div>
        </dl>
      )}
      {model === "split" && bot.data?.splitError && (
        <p className="sr-note">This split can&apos;t be paid ({bot.data.splitError}). Its share is held, not paid to anyone else.</p>
      )}
      {airdrop && (
        <div className="sr-detail-row">
          <span>Graduation airdrop · {AIRDROP_PERCENT}% of supply</span>
          <strong>{airdropText(bot.data?.airdrop, bot.readAt)}</strong>
        </div>
      )}
      {bot.loaded && !bot.data && <p className="sr-note">Payout history is unavailable right now.</p>}
      <Link className="sr-text-link" href={marketHref(m)}>
        Open market <ArrowUpRight size={13} />
      </Link>
    </li>
  );
}

function BackedRow({ market: m, facts }: { market: Market; facts?: MarketFacts }) {
  const profile = useTokenProfile(m.uri);
  const quote = quoteSymbolOf(m.quoteMint);
  return (
    <li className="reward-row">
      <div className="reward-row-head">
        <PairLabel market={m} profile={profile} />
        <MarketBadges market={m} data={{ airdrop: false, volatilityFee: false, mode: m.mode, floor: facts?.floor }} quote={quote} />
      </div>
      <div className="sr-detail-row">
        <span>Backing</span>
        <strong>{facts?.floor !== undefined ? `${formatUnits(facts.floor, m.quoteDecimals)} ${quote}` : "—"}</strong>
      </div>
      <Link className="sr-text-link" href={marketHref(m)}>
        Burn for your share <ArrowUpRight size={13} />
      </Link>
    </li>
  );
}

function PayingMarkets({ overview, loading, refresh }: { overview?: Overview; loading: boolean; refresh: string }) {
  const [view, setView] = useState<"paying" | "backed">("paying");
  const markets = overview?.markets ?? NONE;
  const reward = useMemo(() => markets.filter(isRewardMarket).sort(bySymbol), [markets]);
  // Until the new bot runs, a Reward token whose metadata names a fee module is not shown as paying.
  const models = useFeeModels(PAYOUT_BOT_V2 ? NONE : reward);
  const facts = overview?.facts;
  const paying = [
    ...reward.filter((m) => PAYOUT_BOT_V2 || (models && listsModel(botModel(models.get(m.pool), m.feeModel), false))),
    ...(PAYOUT_BOT_V2 ? markets.filter((m) => !isRewardMarket(m) && facts?.get(m.pool)?.airdrop).sort(bySymbol) : []),
  ];
  const backed = markets.filter((m) => hasFloor(m.mode)).sort(bySymbol);
  const ready = !!overview && (PAYOUT_BOT_V2 || !!models);
  const list = view === "paying" ? paying : backed;
  return (
    <section className="rewards-section" aria-labelledby="rewards-paying">
      <div className="sr-section-top">
        <h2 id="rewards-paying">Paying markets</h2>
      </div>
      <div className="curve-presets rewards-kinds" role="group" aria-label="Show">
        <button type="button" aria-pressed={view === "paying"} onClick={() => setView("paying")}>
          <strong>{ready ? paying.length : "—"}</strong>
          <span>{PAYOUT_BOT_V2 ? "Paying markets · every 15 min" : "Reward tokens · paid every 15 min"}</span>
        </button>
        <button type="button" aria-pressed={view === "backed"} onClick={() => setView("backed")}>
          <strong>{overview ? backed.length : "—"}</strong>
          <span>Backed tokens · burn for your share</span>
        </button>
      </div>
      {!ready ? (
        (loading || !!overview) && <p className="sr-note">Reading markets…</p>
      ) : !list.length ? (
        <Card className="sr-panel rewards-empty">
          {view === "paying" ? <Gift size={22} aria-hidden /> : <ShieldCheck size={22} aria-hidden />}
          <p>
            {view === "paying"
              ? "No Reward tokens yet. Launch one and its holders are paid from every trade."
              : "No Backed tokens yet. A Backed token keeps part of its fees as stock that holders can burn tokens for."}
          </p>
          <Button asChild variant="outline" size="sm">
            <Link href="/create">
              Launch a token <ArrowUpRight />
            </Link>
          </Button>
        </Card>
      ) : (
        <ul className="reward-list" aria-label={view === "paying" ? "Paying markets" : "Backed tokens"}>
          {view === "paying"
            ? paying.map((m) => <PayingRow key={m.pool} market={m} facts={facts?.get(m.pool)} refresh={refresh} />)
            : backed.map((m) => <BackedRow key={m.pool} market={m} facts={facts?.get(m.pool)} />)}
        </ul>
      )}
      {view === "backed" && overview?.factsError && <p className="sr-note">Backing amounts are unavailable: {overview.factsError}</p>}
      <p className="sr-note">Standard tokens pay only their creator, so they aren&apos;t listed.</p>
    </section>
  );
}

function YourRewards({ overview, refresh }: { overview?: Overview; refresh: string }) {
  const { address } = useLive();
  const wallet = useWallet(address, refresh);
  const byPool = useMemo(() => new Map((overview?.markets ?? NONE).map((m) => [m.pool, m])), [overview]);
  if (!address)
    return (
      <section className="rewards-section" aria-labelledby="rewards-yours">
        <div className="sr-section-top">
          <h2 id="rewards-yours">Your rewards</h2>
        </div>
        <Card className="sr-panel rewards-connect">
          <p>Connect a wallet to see what the bot has paid you and what your Backed tokens are worth.</p>
          <WalletConnectButton />
        </Card>
      </section>
    );
  const totals = wallet.payouts ? stockTotals(wallet.payouts, (pool) => byPool.get(pool)?.quoteMint) : [];
  const backed = (overview?.markets ?? NONE).filter((m) => hasFloor(m.mode));
  const holdings =
    wallet.balances && overview
      ? walletBacking(
          backed.map((m) => {
            const f = overview.facts.get(m.pool);
            return {
              pool: m.pool,
              baseMint: m.baseMint,
              floor: f?.floor !== undefined ? BigInt(f.floor) : null,
              supply: f?.baseSupply !== undefined ? BigInt(f.baseSupply) : null,
            };
          }),
          wallet.balances,
        )
      : undefined;
  return (
    <section className="rewards-section" aria-labelledby="rewards-yours">
      <div className="sr-section-top">
        <h2 id="rewards-yours">Your rewards</h2>
      </div>
      <div className="rewards-mine">
        <Card className="sr-panel">
          <h3>Paid to you</h3>
          {wallet.payoutsError ? (
            <p className="sr-note">{wallet.payoutsError}</p>
          ) : !wallet.payouts || !overview ? (
            <p className="sr-note">Reading your payouts…</p>
          ) : !wallet.payouts.length ? (
            <p className="sr-note">Nothing paid to this wallet yet. Reward tokens pay holders of at least 0.01% of the supply (not the token&apos;s creator) every 15 minutes.</p>
          ) : (
            <>
              {!!totals.length && (
                <div className="rewards-totals" aria-label="Total paid to you">
                  {totals.map((t) => (
                    <span className="rewards-total" key={t.mint}>
                      {formatUnits(t.amount)} <TokenName symbol={quoteSymbolOf(t.mint)} size={16} />
                    </span>
                  ))}
                </div>
              )}
              <div className="bot-list">
                {wallet.payouts.map((p) => {
                  const m = byPool.get(p.pool);
                  const unit = p.asset === "base" ? (m?.symbol ?? "tokens") : m ? quoteSymbolOf(m.quoteMint) : "";
                  const decimals = p.asset === "base" ? (m?.baseDecimals ?? 6) : (m?.quoteDecimals ?? 8);
                  return (
                    <div className="sr-detail-row" key={`${p.pool}/${p.module}`}>
                      <span>
                        {m ? <Link href={marketHref(m)}>{m.symbol}</Link> : short(p.pool)} · {kindName(p.module)}
                        <small className="rewards-meta">
                          {p.payouts} {p.payouts === 1 ? "payout" : "payouts"}
                          {p.lastPaidAt ? ` · last ${sinceText(p.lastPaidAt, wallet.readAt)}` : ""}
                        </small>
                      </span>
                      <strong>
                        {formatUnits(p.paid, decimals)} {unit}
                      </strong>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Card>
        <Card className="sr-panel">
          <h3>Your backing</h3>
          {wallet.balancesError ? (
            <p className="sr-note">{wallet.balancesError}</p>
          ) : !holdings ? (
            <p className="sr-note">Reading your balances…</p>
          ) : !holdings.length ? (
            <p className="sr-note">You don&apos;t hold any Backed tokens.</p>
          ) : (
            <div className="bot-list">
              {holdings.map((h) => {
                const m = byPool.get(h.pool)!;
                const quote = quoteSymbolOf(m.quoteMint);
                return (
                  <div className="sr-detail-row" key={h.pool}>
                    <span>
                      {m.symbol} · you hold {formatUnits(h.held, m.baseDecimals)}
                      <Link className="rewards-meta" href={marketHref(m)}>
                        Burn on the market →
                      </Link>
                    </span>
                    <strong>{h.share === null ? "—" : `${formatUnits(h.share, m.quoteDecimals)} ${quote}`}</strong>
                  </div>
                );
              })}
            </div>
          )}
          <p className="sr-note">What your tokens get from the backing if you burn them all.</p>
        </Card>
      </div>
    </section>
  );
}

// The first rewards program's holder rounds (ROOM / mSPY), before the payout
// bot: creators funded each round by hand. Read only when opened.
function EarlierRounds() {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<{ data?: HolderRewards; error?: string } | null>(null);
  useEffect(() => {
    if (!open || read?.data) return;
    let active = true;
    import("@/lib/rewards/holders")
      .then(({ readHolderRewards }) => readHolderRewards())
      .then(
        (data) => active && setRead({ data }),
        (e) => active && setRead({ error: message(e, "Earlier rounds are unavailable.") }),
      );
    return () => {
      active = false;
    };
  }, [open, read?.data]);
  const rounds = read?.data?.rounds.filter((r) => r.campaign) ?? [];
  const program = "6u1nXj1iXNxCGThKetW45MSpXeEdn5GFw6NaZa4Mpn1L";
  return (
    <details className="sr-panel rewards-earlier" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        Earlier rounds <small>ROOM / mSPY · the first rewards program</small>
      </summary>
      <p className="sr-note">
        Before the payout bot, creators funded holder rounds by hand. These rounds are kept here as a record.{" "}
        <a href={explorer("address", program)} target="_blank" rel="noreferrer">
          Program ↗
        </a>
      </p>
      {read?.error ? (
        <p className="sr-note">{read.error}</p>
      ) : !read?.data ? (
        open && <p className="sr-note">Reading earlier rounds…</p>
      ) : !rounds.length ? (
        <p className="sr-note">No earlier rounds.</p>
      ) : (
        <div className="bot-list">
          {rounds.map((r) => (
            <div className="sr-detail-row" key={r.address}>
              <span>
                Round {r.number} · {new Date(r.createdAt * 1000).toLocaleDateString()}
                <small className="rewards-meta">
                  <a href={explorer("address", r.address)} target="_blank" rel="noreferrer">
                    Round ↗
                  </a>{" "}
                  <a href={explorer("address", r.campaign!.address)} target="_blank" rel="noreferrer">
                    Payouts ↗
                  </a>
                </small>
              </span>
              <strong>
                {r.campaign!.remaining === "0"
                  ? `${formatUnits(r.campaign!.funded)} mSPY to ${r.campaign!.allocations.length} holders`
                  : `${formatUnits(r.campaign!.claimed)} of ${formatUnits(r.campaign!.funded)} mSPY delivered to ${r.campaign!.allocations.length} holders`}
              </strong>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

export default function RewardsPage() {
  const { revision } = useLive();
  const [nonce, setNonce] = useState(0);
  const refresh = `${revision}:${nonce}`;
  const { data, error, loading } = useOverview(refresh);
  return (
    <>
      <div className="sr-heading">
        <div>
          <span className="sr-eyebrow">SONATA / REWARDS</span>
          <h1>Rewards</h1>
          <p>Hold Reward tokens, earn stocks. Sonata&apos;s payout bot pays every 15 minutes, in the stock each token trades against.</p>
        </div>
        <Button variant="outline" disabled={loading} onClick={() => setNonce((n) => n + 1)}>
          <RefreshCw className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>
      <LiveWallet />
      {error && (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <PayingMarkets overview={data} loading={loading} refresh={refresh} />
      <YourRewards overview={data} refresh={refresh} />
      <EarlierRounds />
    </>
  );
}
