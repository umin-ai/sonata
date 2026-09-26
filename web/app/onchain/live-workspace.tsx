"use client";
import { TokenName, TokenPair } from "@/app/token-identity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "@/app/plain-link";
import {
  ArrowUpRight,
  ArrowRight,
  Plus,
  RefreshCw,
  Search,
  Sprout,
  Gift,
  AudioLines,
  ShieldCheck,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  hasFloor,
  discoverMarkets,
  marketFromIdentity,
  readWalletBalances,
  connection,
  market as original,
  explorer,
  type Market,
} from "@/lib/treasury/runtime";
import {
  SNAPSHOT_CHAIN_AFTER_MS,
  SNAPSHOT_FRESH_MS,
  SNAPSHOT_NUMBERS_MAX_AGE_MS,
  stableOrder,
  type HomeSnapshot,
  type MarketIdentity,
  type MarketPageSnapshot,
  type SnapshotEntry,
} from "@/lib/treasury/market-snapshot";
import { fetchSnapshot, listFromSnapshot, readLive, type MarketList } from "./markets-client";
import { SnapshotProvider } from "./snapshot-context";
import { PublicKey } from "@solana/web3.js";
import { formatUnits } from "@/lib/treasury/units";
import { LiveWallet, useLive } from "./live-session";
import { OnchainTreasury } from "./treasury-workspace";
import { LiquidityPortfolio } from "@/app/earn/demo-portfolio";
import { GraduationProgress } from "./graduation-progress";
import { MarketBadges } from "./market-badges";
import { MarketStats } from "./market-activity";
import { isDeployableQuote } from "@/lib/treasury/quote-assets";
import {
} from "@/app/token-profile-fields";
import { TokenImage, useTokenProfile } from "@/app/token-profile-view";
import { quoteSymbolOf } from "@/lib/treasury/quote-assets";
const short = (s: string) => `${s.slice(0, 5)}…${s.slice(-5)}`;
const href = (m: Pick<Market, "pool">) => `/onchain?pool=${m.pool}`;
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
// Registered markets exist but none could be verified: an error, not "Make the first move".
const NOTHING_VERIFIED = "No registered market could be verified right now.";
/**
 * The market list and every card's numbers. With the server's snapshot
 * (`initial`) the list is complete from the first render and nothing is read
 * on mount unless it is stale: 15 s to 60 s old, a quiet /api/markets; older,
 * a quiet chain read. Without it, /api/markets (4 s limit), else the chain,
 * behind today's skeletons. After a confirmed transaction the browser reads
 * the chain quietly; Refresh reads the chain (else the server) with the spinner.
 * A quiet read that fails keeps the list shown.
 */
function useMarkets(initial?: HomeSnapshot | null) {
  const { revision } = useLive();
  const [list, setList] = useState<SnapshotEntry[]>(() => initial?.entries ?? []);
  const [error, setError] = useState(() =>
    initial && !initial.entries.length && initial.skipped.length ? NOTHING_VERIFIED : "",
  );
  // Visible loads in flight (the first one without a snapshot, and Refresh clicks).
  const [visible, setVisible] = useState(() => (initial ? 0 : 1));
  const latest = useRef(0);
  const load = useCallback(async (sources: (() => Promise<MarketList>)[], shown: boolean) => {
    const id = ++latest.current;
    let result: MarketList | null = null,
      failure: unknown = null;
    for (const source of sources) {
      try {
        result = await source();
        break;
      } catch (e) {
        failure = e;
      }
    }
    if (id === latest.current) {
      if (result) {
        const next = result;
        setList((shownList) => stableOrder(shownList, next.entries));
        setError(!next.entries.length && next.skipped ? NOTHING_VERIFIED : "");
      } else if (shown) setError(message(failure, "Markets unavailable"));
    }
    if (shown) setVisible((n) => Math.max(0, n - 1));
  }, []);
  const fromServer = useCallback(
    (timeoutMs?: number) => async () => listFromSnapshot(await fetchSnapshot(timeoutMs)),
    [],
  );
  useEffect(() => {
    // Everything load() sets happens after its first await, never during the effect.
    const sources = !initial
      ? [fromServer(4_000), readLive]
      : initial.ageMs + performance.now() > SNAPSHOT_CHAIN_AFTER_MS
        ? [readLive]
        : initial.ageMs + performance.now() > SNAPSHOT_FRESH_MS
          ? [fromServer()]
          : null;
    if (sources) queueMicrotask(() => void load(sources, !initial));
  }, [initial, load, fromServer]);
  useEffect(() => {
    if (revision) queueMicrotask(() => void load([readLive], false));
  }, [revision, load]);
  const refresh = useCallback(() => {
    setVisible((n) => n + 1);
    setError("");
    void load([readLive, fromServer()], true);
  }, [load, fromServer]);
  return { list, error, loading: visible > 0, refresh };
}
function Heading({
  title,
  description,
  refresh,
}: {
  title: string;
  description: string;
  refresh?: () => void;
}) {
  return (
    <div className="sr-heading">
      <div>
        <span className="sr-eyebrow">SONATA</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {refresh && (
        <Button variant="outline" onClick={refresh}>
          <RefreshCw />
          Refresh
        </Button>
      )}
    </div>
  );
}
function Failure({ text }: { text: string }) {
  return text ? (
    <Alert variant="destructive" className="mb-5">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  ) : null;
}
function Address({ value }: { value: string }) {
  return (
    <a
      className="sr-text-link"
      href={explorer("address", value)}
      target="_blank"
      rel="noreferrer"
    >
      {short(value)}
      <ArrowUpRight size={13} />
    </a>
  );
}
export function LiveDirectory({ initial = null }: { initial?: HomeSnapshot | null }) {
  const { list, error, loading, refresh } = useMarkets(initial);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | "floor">("all");
  const filtered = list.filter(({ market: m }) =>
    `${m.symbol} ${m.name} ${quoteSymbolOf(m.quoteMint)}`.toLowerCase().includes(query.toLowerCase()) && (category === "all" || hasFloor(m.mode)),
  );
  return (
    <SnapshotProvider profiles={initial?.profiles} prices={initial?.prices} stats={initial?.stats} locale={initial?.locale}>
      <div className="sonata-welcome"><div><span className="sonata-kicker">SONATA / DISCOVER</span><h1>The marketplace<span>.</span></h1></div></div>
      <div className="sonata-lobby sonata-command-lobby">
        <section className="sonata-command-banner" aria-labelledby="sonata-feature-title">
          <div className="sonata-command-copy">
            <span className="sonata-command-label"><AudioLines size={14} /> COMMUNITY TOKENS. STOCK-POWERED PAIRS.</span>
            <h2 id="sonata-feature-title">MAKE YOUR<br /><em>NEXT MOVE.</em></h2>
            <p>Find your market. Or create the next one.</p>
            <div className="sonata-command-actions"><Button asChild><Link href="/create"><Plus size={15} /> Launch token <ArrowUpRight size={15} /></Link></Button><Link href="/ecosystem" className="sonata-command-learn">How Sonata works <ArrowRight size={14} /></Link></div>
          </div>
          <div className="sonata-command-art" aria-hidden="true">
            <div className="sonata-command-orbit orbit-outer" /><div className="sonata-command-orbit orbit-inner" />
            <div className="sonata-command-core"><AudioLines className="sonata-command-wave" /></div>
            <span className="sonata-command-cross cross-one">+</span><span className="sonata-command-cross cross-two">+</span>
            <div className="sonata-command-signature"><span>SONATA</span><small>STOCK-POWERED MARKETS</small></div>
            <span className="sonata-command-bars"><i /><i /><i /><i /><i /><i /><i /></span>
          </div>
          <div className="sonata-command-route"><span>01 / LAUNCH</span><span>02 / TRADE</span><span>03 / EARN</span><AudioLines size={15} /></div>
        </section>
        <aside className="sonata-shortcuts" aria-label="Explore Sonata">
          <Link href={`/onchain?pool=${original.pool}`} className="sonata-shortcut"><span className="sonata-shortcut-icon violet"><AudioLines /></span><div><small>01 / FEATURED MARKET</small><strong>ROOM <span>/ mSPY</span></strong></div><ArrowUpRight size={18} /></Link>
          <Link href="/earn" className="sonata-shortcut"><span className="sonata-shortcut-icon ice"><Sprout /></span><div><small>02 / LIQUIDITY</small><strong>Explore pools</strong></div><ArrowUpRight size={18} /></Link>
          <Link href="/rewards" className="sonata-shortcut"><span className="sonata-shortcut-icon lavender"><Gift /></span><div><small>03 / REWARDS</small><strong>Holder rewards</strong></div><ArrowUpRight size={18} /></Link>
        </aside>
      </div>
      <div className="sonata-discovery-layout"><div className="sonata-discovery-main">
      <section className="nm-markets" aria-labelledby="market-heading">
        <div className="nm-section-heading">
          <div>
            <span className="sr-eyebrow">DISCOVER YOUR NEXT MOVE</span>
            <h2 id="market-heading">Market radar <AudioLines size={21} /></h2>
            <p>
              Explore community markets paired with mock stock tokens.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={loading}
            onClick={refresh}
            aria-label="Refresh markets"
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
        <div className="nm-market-toolbar">
          <div className="sonata-market-tabs" aria-label="Filter markets">
            <button type="button" aria-pressed={category === "all"} onClick={() => setCategory("all")}>All markets <span>{loading ? "…" : list.length}</span></button>
            <button type="button" aria-pressed={category === "floor"} onClick={() => setCategory("floor")}><ShieldCheck size={14} /> Backed</button>
          </div>
          <div className="nm-market-search">
            <Search size={17} />
            <Input
              aria-label="Search markets"
              placeholder="Search markets"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        {error && <Alert className="mb-5"><AlertDescription>Market data is temporarily unavailable. Refresh to try again, or explore the launch studio.</AlertDescription></Alert>}
        <div className="nm-market-grid">
          {!query.trim() && category === "all" && (
            <Link href="/create" className="sonata-launch-card" aria-label="Launch token — create your own market">
              <span className="sonata-launch-kicker">CREATOR SLOT <span aria-hidden="true">{"///"}</span></span>
              <span className="sonata-launch-sigil" aria-hidden="true"><Plus strokeWidth={1.5} /></span>
              <div className="sonata-launch-copy"><h3>LAUNCH<br />TOKEN</h3><p>Your community. Your market.</p></div>
              <span className="sonata-launch-action">CHOOSE YOUR STOCK PAIR <ArrowUpRight size={16} /></span>
            </Link>
          )}
          {loading && !list.length
            ? [1, 2, 3, 4].map((n) => (
                <div
                  className="nm-market-skeleton"
                  key={n}
                  aria-label="Loading market"
                >
                  <span />
                  <span />
                  <span />
                </div>
              ))
            : filtered.map((entry) => <MarketCard key={entry.market.pool} market={entry.market} card={entry} />)}
        </div>
        {!loading && !error && !filtered.length && (
          <Card className="sr-panel nm-empty">
            <Search />
            <h3>{query ? "No matching markets" : "Make the first move."}</h3>
            <p>
              {query
                ? "Try another name or symbol."
                : "Create the first stock-paired community market."}
            </p>
            <Button variant="outline" onClick={() => { setQuery(""); setCategory("all"); }}>
              Clear search
            </Button>
          </Card>
        )}
      </section>
      </div>
      </div>
      <section className="sonata-pair-section"><div className="sonata-panel-title"><div><span className="sr-eyebrow">CHOOSE YOUR STARTING POINT</span><h2>Pick your pair</h2></div><Link href="/create">Launch studio <ArrowUpRight size={15} /></Link></div>
      <div className="sonata-pairs">{[
        ["mSPY","S&P 500"], ["mQQQ","Nasdaq 100"], ["mTSLA","Tesla"], ["mNVDA","NVIDIA"], ["mMSFT","Microsoft"],
        ["mAMZN","Amazon"], ["mMETA","Meta"], ["mMCD","McDonald's"], ["mANTHROPIC","Anthropic"]
      ].map(([symbol,name]) => isDeployableQuote(symbol) ? <Link key={symbol} href={`/create?quote=${symbol}`} className="sonata-pair"><TokenName symbol={symbol} size={30}/><span>{name}</span><small>Launch <ArrowUpRight size={12} /></small></Link> : <div key={symbol} className="sonata-pair" aria-disabled="true"><TokenName symbol={symbol} size={30}/><span>{name}</span><small>Coming soon</small></div>)}</div></section>
      <p className="sonata-market-note">Community tokens are distinct from the stocks they trade against and do not convey stock ownership.</p>
    </SnapshotProvider>
  );
}

// One market's card. Its numbers come with the list (the server's snapshot or
// the list's batched read), checked exactly as readTreasury checks them.
function MarketCard({ market: m, card }: { market: MarketIdentity; card: Pick<SnapshotEntry, "data" | "error"> }) {
  const data = card.data,
    error = card.data ? "" : (card.error ?? "");
  const tokenProfile = useTokenProfile(m.uri);
  return (
    <Card className="sonata-token-card" data-sonata-tone={m.baseMint.charCodeAt(0) % 3} data-heat={data?.heat}>
      {(data?.heat === "heating" || data?.heat === "fire" || data?.heat === "complete") && (
        <span className="sonata-heat-overlay" aria-hidden="true">
          <svg viewBox="0 0 24 30" fill="currentColor">
            <path d="m3 12 9-9 9 9v6l-9-9-9 9Z" />
            <path d="m3 22 9-9 9 9v6l-9-9-9 9Z" />
          </svg>
        </span>
      )}
      <Link href={href(m)} className="sonata-token-identity" aria-label={`Open ${m.name} market`}>
        <span className="sonata-token-avatar" aria-hidden="true"><span>?</span><TokenImage profile={tokenProfile} symbol={m.symbol} size={42} fallback={false} /></span>
        <div><h3>{m.symbol}</h3><p title={m.name}>{m.name}</p></div>
        <ArrowUpRight size={16} />
      </Link>
      <div className="sonata-token-pair"><span>Paired with</span><TokenName symbol={quoteSymbolOf(m.quoteMint)} size={20} />
        <MarketBadges market={m} data={data} feeModel={tokenProfile?.feeModel} quote={quoteSymbolOf(m.quoteMint)} />
      </div>
      <GraduationProgress data={data} quote={quoteSymbolOf(m.quoteMint)} compact />
      <div className="sonata-token-activity"><MarketStats pool={m.pool} quote={quoteSymbolOf(m.quoteMint)} /></div>
      {error && <p className="sonata-token-error">Chain data unavailable · <Link href={href(m)}>Open market to retry</Link></p>}
    </Card>
  );
}
/**
 * One market's page (/onchain?pool=…; `pool` comes from the page, so the
 * server and the browser pick the same branch). With the server's snapshot
 * entry for it, the market (rebuilt from its identity) renders at once, with
 * the snapshot's numbers until the live read verifies it. Otherwise the
 * browser finds it on the chain first, as before.
 */
export function LiveMarket({ pool, initial = null }: { pool: string; initial?: MarketPageSnapshot | null }) {
  const seeded = useMemo(() => {
    if (!initial || initial.entry.market.pool !== pool) return null;
    try {
      return marketFromIdentity(initial.entry.market);
    } catch {
      return null;
    }
  }, [initial, pool]);
  const profiles = useMemo(
    () => (initial?.profile && seeded?.uri ? { [seeded.uri]: initial.profile } : undefined),
    [initial, seeded],
  );
  const prices = useMemo(
    () => (initial && seeded && initial.price !== undefined ? { [quoteSymbolOf(seeded.quoteMint)]: initial.price } : undefined),
    [initial, seeded],
  );
  if (!initial || !seeded) return <DiscoveredMarket pool={pool} />;
  return (
    <SnapshotProvider profiles={profiles} prices={prices} locale={initial.locale}>
      <OnchainTreasury
        key={pool}
        selected={seeded}
        initialData={initial.ageMs <= SNAPSHOT_NUMBERS_MAX_AGE_MS ? initial.entry.data : null}
      />
    </SnapshotProvider>
  );
}
// A market the server's snapshot does not have (launched moments ago, or not a
// Sonata market): found on the chain first. Once found it is kept, so a later
// transaction does not look it up again; until then, one does.
function DiscoveredMarket({ pool }: { pool: string }) {
  const { revision } = useLive();
  const [found, setFound] = useState<{ market: Market | null; error: string } | null>(null);
  const known = !!found?.market;
  useEffect(() => {
    if (known) return;
    let active = true;
    discoverMarkets().then(
      (markets) => active && setFound({ market: markets.find((m) => m.pool === pool) ?? null, error: "" }),
      (e) => active && setFound((last) => ({ market: last?.market ?? null, error: message(e, "Markets unavailable") })),
    );
    return () => {
      active = false;
    };
  }, [pool, revision, known]);
  if (found?.market) return <OnchainTreasury key={pool} selected={found.market} />;
  return (
    <>
      <Heading
        title="Open market"
        description={
          !found
            ? "Verifying market registration on Solana…"
            : "This pool is not registered with the supported Sonata configuration."
        }
      />
      <Failure text={found?.error ?? ""} />
      <Button asChild variant="outline">
        <Link href="/">Back to markets</Link>
      </Button>
    </>
  );
}
export { LiveLaunch } from "./live-launch";
export function LivePortfolio() {
  const { address, revision } = useLive();
  const [liquidityRefresh, setLiquidityRefresh] = useState(0);
  const { list, error, loading, refresh } = useMarkets();
  // The wallet's balances in every listed market in one batched read, re-read
  // when the wallet, the set of markets or the chain (a confirmed transaction)
  // changes, not every time the list's numbers refresh.
  const pools = list.map((e) => e.market.pool).join(",");
  const [listed, setListed] = useState({ pools: "", markets: [] as MarketIdentity[] });
  if (listed.pools !== pools) setListed({ pools, markets: list.map((e) => e.market) });
  const key = address ? `${address}|${pools}|${revision}` : "";
  const [read, setRead] = useState<{
    key: string;
    balances?: Awaited<ReturnType<typeof readWalletBalances>>;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!key || !listed.markets.length) return;
    let active = true;
    readWalletBalances(address, listed.markets).then(
      (balances) => active && setRead({ key, balances }),
      (e) => active && setRead({ key, error: message(e, "Balances unavailable") }),
    );
    return () => {
      active = false;
    };
  }, [key, address, listed]);
  const current = read?.key === key ? read : null;
  const fetching = !!key && !!listed.markets.length && !current;
  // Creator reserves come with the list's card numbers (display only).
  const positions = current?.balances
    ? list.flatMap(({ market, data }) => {
        const balance = current.balances!.get(market.pool);
        return balance ? [{ market, balance, treasury: { available: data?.available ?? "0" } }] : [];
      })
    : [];
  const failure =
    current?.error ?? list.find((e) => !e.data && e.error && e.market.creator === address)?.error ?? "";
  return (
    <>
      <Heading
        title="Your portfolio."
        description="Wallet tokens, liquidity positions and creator reserves. Read directly from Solana."
        refresh={() => {
          setLiquidityRefresh((v) => v + 1);
          void refresh();
        }}
      />
      <LiveWallet />
      <Failure text={error || failure} />
      {address && (
        <>
          {/* One wallet and reserve figure per quote token: amounts in different
              mock stocks are never added together. */}
          <div className="sr-stats">
            {[...new Set(positions.map((p) => p.market.quoteMint))].map((mint) => {
              const rows = positions.filter((p) => p.market.quoteMint === mint);
              const q = quoteSymbolOf(mint);
              return (
                <Card key={mint}>
                  <span>
                    Wallet <TokenName symbol={q} />
                  </span>
                  <strong>{formatUnits(rows[0].balance.quote)}</strong>
                  <small>
                    Creator reserves{" "}
                    {formatUnits(
                      rows
                        .filter((p) => p.market.creator === address)
                        .reduce((sum, p) => sum + BigInt(p.treasury.available), 0n),
                    )}{" "}
                    {q} · across {rows.length} market{rows.length === 1 ? "" : "s"}
                  </small>
                </Card>
              );
            })}
            <Card>
              <span>Devnet SOL</span>
              <strong>
                {positions[0] ? formatUnits(positions[0].balance.sol, 9) : "—"}
              </strong>
              <small>For transaction fees</small>
            </Card>
          </div>
          <Card className="sr-panel">
            <h3>Community holdings</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market</TableHead>
                  <TableHead>Wallet tokens</TableHead>
                  <TableHead>Your role</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((p) => (
                  <TableRow key={p.market.pool}>
                    <TableCell>
                      <TokenPair base={p.market.symbol} quote={quoteSymbolOf(p.market.quoteMint)} size={24} />
                    </TableCell>
                    <TableCell>{formatUnits(p.balance.base, 6)}</TableCell>
                    <TableCell>
                      {p.market.creator === address
                        ? "Creator"
                        : p.market.payoutOwner === address
                          ? "Fee recipient"
                          : "Trader"}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" asChild>
                        <Link href={href(p.market)}>
                          Manage
                          <ArrowUpRight />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {(loading || fetching) && (
              <p className="sr-note">Reading balances…</p>
            )}
          </Card>
          <LiquidityPortfolio refreshToken={liquidityRefresh} />
          <Card className="sr-panel mt-6">
            <h3>Your tokens&apos; fees</h3>
            <p className="sr-note">
              What each token you launched has paid you, and what is waiting to claim.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild variant="outline">
                <Link href="/capital">
                  My tokens
                  <ArrowUpRight />
                </Link>
              </Button>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
export function LiveActivity() {
  const { address, revision, labels } = useLive();
  const [rows, setRows] = useState<
      Awaited<ReturnType<typeof connection.getSignaturesForAddress>>
    >([]),
    [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (!address) return;
    setError("");
    try {
      setRows(
        await connection.getSignaturesForAddress(
          new PublicKey(address),
          { limit: 30 },
          "confirmed",
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "History unavailable");
    }
  }, [address]);
  useEffect(() => {
    setRows([]);
    void refresh();
  }, [refresh, revision]);
  return (
    <>
      <Heading
        title="Wallet activity."
        description="Confirmed network receipts, including transactions made outside Sonata."
        refresh={refresh}
      />
      <LiveWallet />
      <Failure text={error} />
      {address && (
        <Card className="sr-panel">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Operation</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Receipt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.signature}>
                  <TableCell>
                    {labels[r.signature] ?? "Wallet transaction"}
                  </TableCell>
                  <TableCell>
                    {r.blockTime
                      ? new Date(r.blockTime * 1000).toLocaleString()
                      : "Pending timestamp"}
                  </TableCell>
                  <TableCell>
                    {r.err ? "Failed" : r.confirmationStatus}
                  </TableCell>
                  <TableCell>
                    <a
                      className="sr-text-link"
                      href={explorer("tx", r.signature)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {short(r.signature)}
                      <ArrowUpRight size={13} />
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!rows.length && (
            <p className="sr-note">No receipts loaded for this wallet.</p>
          )}
        </Card>
      )}
    </>
  );
}
