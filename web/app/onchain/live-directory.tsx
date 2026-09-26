"use client";
// The market list (the home page), in its own module so the home page loads
// only what the list needs, not the market page, portfolio or charts.
import { memo, useMemo, useState } from "react";
import Link from "@/app/plain-link";
import { ArrowUpRight, ArrowRight, Plus, RefreshCw, Search, Sprout, Gift, AudioLines, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TokenName } from "@/app/token-identity";
import { TokenImage, useTokenProfile } from "@/app/token-profile-view";
import { hasFloor, market as original, type Market } from "@/lib/treasury/runtime";
import type { HomeSnapshot, MarketIdentity, SnapshotEntry } from "@/lib/treasury/market-snapshot";
import { isDeployableQuote, quoteSymbolOf } from "@/lib/treasury/quote-assets";
import { SnapshotProvider } from "./snapshot-context";
import { GraduationProgress } from "./graduation-progress";
import { MarketBadges } from "./market-badges";
import { MarketStats } from "./market-stats";
import { useMarkets } from "./use-markets";
import { LiveStreamProvider, useLiveProfiles, useLiveStreamInstance } from "./live-stream";
const href = (m: Pick<Market, "pool">) => `/onchain?pool=${m.pool}`;

export function LiveDirectory({ initial = null }: { initial?: HomeSnapshot | null }) {
  // New markets and card numbers pushed from the indexer, when the snapshot carries a stream position.
  const live = useLiveStreamInstance({ scope: "list", since: initial?.stream ?? null });
  const { list, error, loading, refresh } = useMarkets(initial, live);
  // The snapshot's 24h stats cover the markets it listed (the stream's cover the rest, market-stats.tsx).
  const statsPools = useMemo(() => initial?.entries.map((e) => e.market.pool), [initial]);
  // Token images of markets added live come with them, so no card asks for its own.
  // A body the server rendered is never replaced by the stream's "none yet".
  const liveProfiles = useLiveProfiles(live);
  const profiles = useMemo(() => {
    const shown = initial?.profiles;
    if (!Object.keys(liveProfiles).length) return shown;
    const merged = { ...shown };
    for (const [uri, body] of Object.entries(liveProfiles)) if (body || !merged[uri]) merged[uri] = body;
    return merged;
  }, [initial, liveProfiles]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | "floor">("all");
  const filtered = list.filter(({ market: m }) =>
    `${m.symbol} ${m.name} ${quoteSymbolOf(m.quoteMint)}`.toLowerCase().includes(query.toLowerCase()) && (category === "all" || hasFloor(m.mode)),
  );
  return (
    <LiveStreamProvider value={live}>
    <SnapshotProvider profiles={profiles} prices={initial?.prices} stats={initial?.stats} statsPools={statsPools} locale={initial?.locale}>
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
    </LiveStreamProvider>
  );
}

// One market's card. Its numbers come with the list (the server's snapshot,
// the live stream or the list's batched read), checked exactly as readTreasury
// checks them. Memoized: a live update of one card re-renders only that card.
const MarketCard = memo(function MarketCard({ market: m, card }: { market: MarketIdentity; card: Pick<SnapshotEntry, "data" | "error"> }) {
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
});
