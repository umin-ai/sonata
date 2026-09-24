"use client";
import { LaunchSettingsStep, initialSettings, canDeploy, type PythState } from "@/app/launch-settings";
import { assessPrice, formatUsd, formatPriceTime, type StockPrice } from "@/lib/pricing/stock-price";
import { previewDbc } from "@/lib/treasury/dbc-preview";
import { WalletConnectButton } from "./wallet-connect";
import { MeteoraLabel } from "@/app/protocol-identity";
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
  Layers3,
  AudioLines,
  ShieldCheck,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  discoverMarkets,
  readTreasury,
  readTradingWallet,
  prepareLaunch,
  prepareRegistration,
  validateMarketIdentity,
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
  TokenProfileFields,
  emptyProfile,
  hasProfile,
  publishProfile,
} from "@/app/token-profile-fields";
import { TokenImage, TokenLinks, useTokenProfile } from "@/app/token-profile-view";
import { normalizeLinks } from "@/lib/token-profile";
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
    `${m.symbol} ${m.name} ${quoteSymbolOf(m.quoteMint)}`.toLowerCase().includes(query.toLowerCase()) && (category === "all" || m.mode === "floor"),
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
            <button type="button" aria-pressed={category === "floor"} onClick={() => setCategory("floor")}><ShieldCheck size={14} /> Stock Floor</button>
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
      ].map(([symbol,name]) => isDeployableQuote(symbol) ? <Link key={symbol} href="/create" className="sonata-pair"><TokenName symbol={symbol} size={30}/><span>{name}</span><small>Launch <ArrowUpRight size={12} /></small></Link> : <div key={symbol} className="sonata-pair" aria-disabled="true"><TokenName symbol={symbol} size={30}/><span>{name}</span><small>Coming soon</small></div>)}</div></section>
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
    <Card className="sonata-token-card" data-sonata-tone={m.baseMint.charCodeAt(0) % 3}>
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
export function LiveLaunch() {
  const { address, busy, pending, execute, revision } = useLive();
  const [step, setStep] = useState(0);
  const [settings,setSettings]=useState(initialSettings);
  const [referencePrice,setReferencePrice]=useState<{quote:string;price:number;at:string}|null>(null);
  useEffect(()=>{let active=true;const controller=new AbortController();setReferencePrice(null);const asset=({mSPY:'spy',mNVDA:'nvda',mQQQ:'qqq',mTSLA:'tsla'} as Record<string,string>)[settings.quote];if(!asset)return()=>{active=false};fetch(`/api/token-market?asset=${asset}`,{signal:controller.signal}).then(async r=>{if(!r.ok)throw Error('Price unavailable');return await r.json() as {price:number;fetchedAt:string}}).then(d=>{if(active&&Number.isFinite(d.price)&&d.price>0)setReferencePrice({quote:settings.quote,price:d.price,at:d.fetchedAt})}).catch(()=>{});return()=>{active=false;controller.abort()}},[settings.quote]);
  const price=referencePrice?.quote===settings.quote?referencePrice.price:null;
  // Pyth Pro price for dollar targets. Fetched when the quote asset changes or the creator refreshes.
  const [pyth,setPyth]=useState<PythState>({status:'loading'});
  const [pythRefresh,setPythRefresh]=useState(0);
  useEffect(()=>{let active=true;const controller=new AbortController();setPyth({status:'loading'});fetch(`/api/stock-price?symbol=${settings.quote}`,{signal:controller.signal}).then(async r=>{const d=await r.json() as ({configured:false}|({configured:true;error?:string}&Partial<StockPrice>));if(!active)return;if(!d.configured){setPyth({status:'unconfigured'});return}if(!r.ok||d.error||typeof d.price!=='number'){setPyth({status:'error',message:d.error??'Price unavailable.'});return}const data=d as StockPrice;const a=assessPrice(data,Date.now());const guard=(d as {guard?:{feed:string;price:number;divergence:number}}).guard;setPyth(a.usable?{status:'ok',data,label:a.label,live:a.live,confidenceRatio:a.confidenceRatio,guard}:{status:'unusable',message:a.reason,data})}).catch(()=>{if(active)setPyth({status:'error',message:'Price unavailable.'})});return()=>{active=false;controller.abort()}},[settings.quote,pythRefresh]);
  const usdEstimate=(n:number)=>price===null?'USD unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(n*price);

  const [curve,setCurve]=useState<Awaited<ReturnType<typeof previewDbc>>|null>(null);
  const [curveError,setCurveError]=useState("");
  useEffect(()=>{let active=true;setCurve(null);setCurveError("");void previewDbc(settings.initial,settings.target,settings.fee).then(result=>{if(active)setCurve(result)}).catch(e=>{if(active)setCurveError(e.message)});return()=>{active=false}},[settings]);
  const deployable=canDeploy(settings);

  const [name, setName] = useState(""),
    [symbol, setSymbol] = useState(""),
    [payout, setPayout] = useState(""),
    [draft, setDraft] = useState<Market | null>(null),
    [exists, setExists] = useState<boolean | null>(null),
    [error, setError] = useState(""),
    [completed, setCompleted] = useState(""),
    [profile, setProfile] = useState(emptyProfile);
  let profileValid = true;
  try {
    normalizeLinks(profile);
  } catch {
    profileValid = false;
  }
  useEffect(() => {
    let active = true;
    setError("");
    try {
      setCompleted(localStorage.getItem("stockroom.last-created") ?? "");
      const raw = localStorage.getItem("stockroom.launch.draft");
      if (!raw) {
        setDraft(null);
        return;
      }
      const m = JSON.parse(raw) as Market;
      validateMarketIdentity(m);
      setDraft(m);
      setExists(null);
      void connection
        .getAccountInfo(new PublicKey(m.pool))
        .then((info) => {
          if (active) setExists(!!info);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    } catch {
      setError(
        "Saved launch is invalid. It has not been used to construct a transaction.",
      );
    }
    return () => {
      active = false;
    };
  }, [revision]);
  const enabled = !!address && !busy && !pending;
  return (
    <>
      <Heading
        title="Launch your token"
        description="Pair your token with mock stocks and collect trading fees."
      />
      <LiveWallet />
      <Failure text={error} />
      {completed && !draft && (
        <Alert className="mb-5">
          <AlertDescription>
            Your latest market is active.{" "}
            <Link className="underline" href={`/onchain?pool=${completed}`}>
              Open it and make the first trade →
            </Link>
          </AlertDescription>
        </Alert>
      )}
      <div className="launch-workspace">
        <nav className="launch-steps" aria-label="Launch steps">{["Token","Pair","Curve","Rewards","Review"].map((label,i)=><button key={label} disabled={!!draft || (i>0 && (!name.trim() || !symbol.trim()))} aria-current={!draft && step===i?"step":undefined} onClick={()=>setStep(i)}><span>{i+1}</span><strong>{label}</strong></button>)}</nav>
        <Card className="sr-panel launch-form">
          <div className="sr-section-top">
            <span className="sr-eyebrow">
              {draft ? "COMPLETE LAUNCH" : `STEP ${step+1} OF 5`}
            </span>
          </div>
          <h3>
            {draft ? <TokenPair base={draft.symbol} quote={quoteSymbolOf(draft.quoteMint)} /> : ["Token details","Choose a pair","Curve & fees","Rewards","Review your launch"][step]}
          </h3>
          {draft ? (
            <div className="space-y-4">
              <p className="sr-note">
                Your launch is saved in this browser. The same pool is resumed
                after a refresh; a second pool is not created.
              </p>
              <div className="sr-detail-row">
                <span>Pool</span>
                <Address value={draft.pool} />
              </div>
              <div className="sr-detail-row">
                <span>Creator</span>
                <Address value={draft.creator} />
              </div>
              <div className="sr-detail-row">
                <span>Fixed recipient</span>
                <Address value={draft.payoutOwner} />
              </div>
              <Button
                disabled={!enabled || !exists || address !== draft.creator}
                onClick={() =>
                  void execute(() => prepareRegistration(address, draft))
                }
              >
                Review treasury activation
              </Button>
              {address && address !== draft.creator && (
                <p className="sr-note">
                  Reconnect the creator wallet to finish activation.
                </p>
              )}
              {exists === false && !pending && (
                <>
                  <p className="sr-note">
                    The pool was not found. If the saved transaction expired,
                    discard this uncreated draft to prepare another launch.
                  </p>
                  <Button
                    variant="outline"
                    disabled={!enabled}
                    onClick={() => {
                      localStorage.removeItem("stockroom.launch.draft");
                      setDraft(null);
                    }}
                  >
                    Discard uncreated draft
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {step === 0 && <><p className="sr-note">Choose a name and ticker for your community token.</p><div>
                <Label htmlFor="market-name">Token name</Label>
                <Input
                  id="market-name"
                  value={name}
                  maxLength={32}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your community"
                />
              </div>
              <div>
                <Label htmlFor="market-symbol">Community ticker</Label>
                <Input
                  id="market-symbol"
                  value={symbol}
                  maxLength={10}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  placeholder="CREW"
                />
              </div>
              <TokenProfileFields value={profile} onChange={setProfile} />
              </>}
              {step >= 1 && step <= 3 && <LaunchSettingsStep step={step} value={settings} onChange={setSettings} price={price} pyth={pyth} onRefreshPrice={()=>setPythRefresh(n=>n+1)}/>}
              {step === 3 && settings.rewards === "treasury" && <div><Label htmlFor="payout-wallet">Fee recipient</Label><Input id="payout-wallet" value={payout} onChange={e=>setPayout(e.target.value)} placeholder={address || "Connected wallet by default"}/><p className="sr-note">Fixed after activation. Leave empty to use your connected wallet.</p></div>}
              {step === 4 && <div className="launch-review"><div className="launch-review-head">{profile.preview && <img className="token-image" src={profile.preview} alt="" width={40} height={40}/>}<TokenPair base={symbol} quote={settings.quote}/></div><div className="sr-detail-row"><span>Token name</span><strong>{name}</strong></div>{profile.description.trim() && <div className="sr-detail-row"><span>Description</span><strong>{profile.description.trim()}</strong></div>}<div className="sr-detail-row"><span>Social links</span><strong>{[profile.website&&"Website",profile.x&&"X",profile.telegram&&"Telegram"].filter(Boolean).join(" · ")||"None"}</strong></div><div className="sr-detail-row"><span>Supply</span><strong>1,000,000,000</strong></div><div className="sr-detail-row"><span>Trading fee</span><strong>{settings.fee/100}%</strong></div><div className="sr-detail-row"><span>Stock Floor</span><strong>{settings.floor?'On · 50% of net fees, creator can never withdraw':'Off · 50% to your withdrawable reserve'}</strong></div>{settings.pricing && <div className="sr-detail-row"><span>Graduates at</span><strong>{formatUsd(settings.pricing.targetUsd)} · {settings.target} {settings.quote}</strong></div>}{settings.pricing && <p className="sr-note">Priced by {settings.pricing.source==='pyth'?'Pyth':'Jupiter (Solana market)'} at {formatUsd(settings.pricing.price)} ({settings.pricing.label}, {formatPriceTime(settings.pricing.publishTimeMs)}).</p>}<p className="sr-note">{deployable ? "Supported Devnet configuration." : "Preview configuration. Deployment is not supported for these settings yet."}</p><p className="sr-note">{deployable ? "Two transactions: launch the token, then activate the treasury. Review the estimated network cost before signing." : "Export these settings for review. No token or pool will be created."}</p></div>}
              <div className="launch-controls">{step>0 && <Button variant="outline" onClick={()=>setStep(step-1)}>Back</Button>}{step<4 ? <Button disabled={!name.trim() || !symbol.trim() || (step===2 && !curve)} onClick={()=>setStep(step+1)}>Continue</Button> : !deployable ? <Button variant="outline" disabled={!curve} onClick={()=>{const blob=new Blob([JSON.stringify({name,symbol,...settings,quoteThresholdAtoms:curve?.quoteThreshold,network:"devnet",deployed:false},null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="stockroom-launch-preview.json";a.click();URL.revokeObjectURL(url);}}>Export configuration</Button> : !address ? <WalletConnectButton /> : <Button
                disabled={!enabled || !name.trim() || !symbol.trim() || !curve || !deployable || !profileValid}
                onClick={() =>
                  void execute(async () => {
                    const launch = (uri: string) =>
                      prepareLaunch(address, name.trim(), symbol, payout.trim() || address, settings, uri);
                    // Publish the metadata first so its URI is fixed into the token. Every
                    // launch gets one, naming Sonata. Without a profile it is optional: a
                    // failed upload, or a name too long to fit a URI in the transaction,
                    // launches with no URI rather than blocking the launch.
                    if (hasProfile(profile)) return launch(await publishProfile(name.trim(), symbol, profile));
                    const uri = await publishProfile(name.trim(), symbol, profile).catch(() => "");
                    return launch(uri).catch((e: Error) => {
                      if (uri && /Shorten the token name/.test(e.message)) return launch("");
                      throw e;
                    });
                  })
                }
              >
                {address ? "Review transaction" : "Connect wallet to launch"}
              </Button>}</div>
              <p className="sr-note mt-3">
                <MeteoraLabel>Powered by Meteora</MeteoraLabel>
              </p>
            </div>
          )}
        </Card>
        <Card className="sr-panel launch-summary">
          <span className="sr-eyebrow">LAUNCH PREVIEW</span>
          <h3><TokenPair base={draft?.symbol || symbol || "TOKEN"} quote={draft ? quoteSymbolOf(draft.quoteMint) : settings.quote}/></h3>
          <p className="sr-note">{name || "Your token name"}</p>
          <div className="sr-detail-row">
            <span>Trading fee</span>
            <strong>{draft ? (draft.fee !== undefined ? `${draft.fee/100}%` : "Set at launch") : `${settings.fee/100}%`} · before protocol deductions</strong>
          </div>
          <div className="sr-detail-row">
            <span>Net collected fees</span>
            <strong>{(draft ? draft.mode==="floor" : settings.rewards==="treasury" && settings.floor) ? "50% recipient / 50% Stock Floor" : draft ? (draft.mode==="duet" ? "50% recipient / 50% creator reserve" : "100% to recipient") : settings.rewards==="treasury" ? "100% to recipient" : settings.rewards==="holders" ? "Holder rewards · preview" : "Liquidity · preview"}</strong>
          </div>
          <div className="sr-detail-row">
            <span>Mock stock</span>
            <strong>
              <TokenName symbol={draft ? quoteSymbolOf(draft.quoteMint) : settings.quote} /> · 8 decimals
            </strong>
          </div>
          <div className="sr-detail-row">
            <span>Community supply</span>
            <strong>1 billion · 6 decimals</strong>
          </div>
          <details className="launch-disclosure"><summary>Launch details & risks</summary><p className="sr-note">
            Creation makes an immutable community mint using Sonata’s
            existing Meteora config. Two wallet approvals: create the pool, then
            register its treasury and custody accounts. Devnet SOL pays network
            fees and account rent; the review estimates the debit. No stock
            purchase is included.
          </p>
          <p className="sr-note">
            The pool graduates toward DAMM v2 at the configured curve threshold.
            Migrated liquidity is permanently locked; Sonata’s DAMM trading
            and fee adapter is not connected yet. This is a test launch, not a
            production offering.
          </p>
          <p className="sr-note">
            The creator can withdraw the allocated reserve. No holder
            redemption, promised APY or automatic rewards.
          </p></details>
          {!draft && <><Badge variant="outline">{deployable ? "Devnet configuration" : "Preview · not deployable"}</Badge><div className="sr-detail-row"><span>Starting market cap</span><strong>{settings.pricing?formatUsd(settings.pricing.openUsd):usdEstimate(settings.initial)}<small className="launch-quote-equivalent">{settings.initial} {settings.quote}</small></strong></div><div className="sr-detail-row"><span>Graduation market cap</span><strong>{settings.pricing?formatUsd(settings.pricing.targetUsd):usdEstimate(settings.target)}<small className="launch-quote-equivalent">{settings.target} {settings.quote}</small></strong></div><div className="sr-detail-row"><span>Quote reserve to graduate</span><strong>{curve ? (Number(curve.quoteThreshold)/1e8).toLocaleString(undefined,{maximumFractionDigits:8}) : "—"} {settings.quote}</strong></div>{curveError && <p role="alert" className="sr-note">{curveError}</p>}<p className="sr-note">Reserve calculated with Meteora’s SDK. Market cap is not the amount raised. Mock tokens have no monetary value.</p>{settings.pricing ? <p className="sr-note">Dollar targets converted at {formatUsd(settings.pricing.price)} per {settings.quote.slice(1)} from {settings.pricing.source==='pyth'?'Pyth':'the Solana market via Jupiter'} ({settings.pricing.feed}, {settings.pricing.label}, {formatPriceTime(settings.pricing.publishTimeMs)}). The curve uses the converted {settings.quote} amounts, fixed at this price.</p> : referencePrice && <p className="sr-note">USD estimates: DEX Screener mainnet reference · {new Date(referencePrice.at).toLocaleTimeString()}</p>}</>}
        </Card>
      </div>
    </>
  );
}
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
