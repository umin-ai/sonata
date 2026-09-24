"use client";
import { TokenName, TokenPair } from "@/app/token-identity";
import { useCallback, useEffect, useState } from "react";
import Link from "@/app/plain-link";
import { useSearchParams } from "next/navigation";
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
  readTreasury,
  readTradingWallet,
  connection,
  market as original,
  explorer,
  type Market,
  type TreasurySnapshot,
} from "@/lib/treasury/runtime";
import { PublicKey } from "@solana/web3.js";
import { formatUnits } from "@/lib/treasury/units";
import { LiveWallet, useLive } from "./live-session";
import { OnchainTreasury } from "./treasury-workspace";
import { LiquidityPortfolio } from "@/app/earn/workspace";
import { GraduationProgress } from "./graduation-progress";
import { StockFloor } from "./stock-floor";
import { MarketStats } from "./market-activity";
import { isDeployableQuote } from "@/lib/treasury/quote-assets";
import {
} from "@/app/token-profile-fields";
import { TokenImage, useTokenProfile } from "@/app/token-profile-view";
import { quoteSymbolOf } from "@/lib/treasury/quote-assets";
const short = (s: string) => `${s.slice(0, 5)}…${s.slice(-5)}`;
const href = (m: Market) => `/onchain?pool=${m.pool}`;
function useMarkets() {
  const { revision } = useLive();
  const [markets, setMarkets] = useState<Market[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setMarkets(await discoverMarkets());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Markets unavailable");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh, revision]);
  return { markets, error, loading, refresh };
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
export function LiveDirectory() {
  const { markets, error, loading, refresh } = useMarkets();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | "floor">("all");
  const filtered = markets.filter((m) =>
    `${m.symbol} ${m.name} ${quoteSymbolOf(m.quoteMint)}`.toLowerCase().includes(query.toLowerCase()) && (category === "all" || hasFloor(m.mode)),
  );
  return (
    <>
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
          <Link href="/onchain" className="sonata-shortcut"><span className="sonata-shortcut-icon violet"><AudioLines /></span><div><small>01 / FEATURED MARKET</small><strong>ROOM <span>/ mSPY</span></strong></div><ArrowUpRight size={18} /></Link>
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
            <button type="button" aria-pressed={category === "all"} onClick={() => setCategory("all")}>All markets <span>{loading ? "…" : markets.length}</span></button>
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
          {loading && !markets.length
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
            : filtered.map((m) => <MarketCard key={m.pool} market={m} />)}
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
        ["mSPY","S&P 500"], ["mQQQ","Nasdaq 100"], ["mTSLA","Tesla"], ["mMSFT","Microsoft"],
        ["mAMZN","Amazon"], ["mMETA","Meta"], ["mMCD","McDonald's"], ["mANTHROPIC","Anthropic"]
      ].map(([symbol,name]) => isDeployableQuote(symbol) ? <Link key={symbol} href={`/create?quote=${symbol}`} className="sonata-pair"><TokenName symbol={symbol} size={30}/><span>{name}</span><small>Launch <ArrowUpRight size={12} /></small></Link> : <div key={symbol} className="sonata-pair" aria-disabled="true"><TokenName symbol={symbol} size={30}/><span>{name}</span><small>Coming soon</small></div>)}</div></section>
      <p className="sonata-market-note">Community tokens are distinct from the stocks they trade against and do not convey stock ownership.</p>
    </>
  );
}

function MarketCard({ market: m }: { market: Market }) {
  const [data, setData] = useState<TreasurySnapshot | null>(null),
    [error, setError] = useState("");
  const tokenProfile = useTokenProfile(m.uri);
  const { revision } = useLive();
  useEffect(() => {
    let active = true;
    void readTreasury(m)
      .then((d) => {
        if (active) {
          setData(d);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [m, revision]);
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
        <span className="sonata-token-avatar" aria-hidden="true"><span>{m.symbol.slice(0, 2)}</span><TokenImage profile={tokenProfile} symbol={m.symbol} size={42} /></span>
        <div><h3>{m.symbol}</h3><p title={m.name}>{m.name}</p></div>
        <ArrowUpRight size={16} />
      </Link>
      <div className="sonata-token-pair"><span>Paired with</span><TokenName symbol={quoteSymbolOf(m.quoteMint)} size={20} />
      </div>
      <StockFloor data={data} market={m} quote={quoteSymbolOf(m.quoteMint)} compact />
      <GraduationProgress data={data} quote={quoteSymbolOf(m.quoteMint)} compact />
      <div className="sonata-token-activity"><MarketStats pool={m.pool} quote={quoteSymbolOf(m.quoteMint)} /></div>
      {error && <p className="sonata-token-error">Chain data unavailable · <Link href={href(m)}>Open market to retry</Link></p>}
    </Card>
  );
}
export function LiveMarket() {
  const search = useSearchParams(),
    pool = search.get("pool") ?? original.pool;
  const { markets, error, loading } = useMarkets();
  const selected = markets.find((m) => m.pool === pool);
  return selected ? (
    <OnchainTreasury key={pool} selected={selected} />
  ) : (
    <>
      <Heading
        title="Open market"
        description={
          loading
            ? "Verifying market registration on Solana…"
            : "This pool is not registered with the supported Sonata configuration."
        }
      />
      <Failure text={error} />
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
  const { markets, error, loading, refresh } = useMarkets();
  const [positions, setPositions] = useState<
      {
        market: Market;
        balance: Awaited<ReturnType<typeof readTradingWallet>>;
        treasury: TreasurySnapshot;
      }[]
    >([]),
    [failure, setFailure] = useState(""),
    [fetching, setFetching] = useState(false);
  useEffect(() => {
    let active = true;
    setPositions([]);
    setFailure("");
    if (!address) return;
    setFetching(true);
    void Promise.all(
      markets.map(async (market) => ({
        market,
        balance: await readTradingWallet(address, market),
        treasury: await readTreasury(market),
      })),
    )
      .then((rows) => {
        if (active) setPositions(rows);
      })
      .catch((e) => {
        if (active) setFailure(e.message);
      })
      .finally(() => {
        if (active) setFetching(false);
      });
    return () => {
      active = false;
    };
  }, [address, markets, revision]);
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
            <h3>Use your creator revenue.</h3>
            <p className="sr-note">
              Deploy your allocated reserve into liquidity, or share newly retained
              fees through a proportional holder-reward policy.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild variant="outline">
                <Link href="/capital">
                  Treasury
                  <ArrowUpRight />
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/rewards">
                  Community rewards
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
