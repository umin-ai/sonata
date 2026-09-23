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
        <span className="sr-eyebrow">SONATA / SOLANA DEVNET</span>
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
  const filtered = markets.filter((m) =>
    `${m.symbol} ${m.name}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <section className="exchange-hero">
        <div><span className="sr-eyebrow">SOLANA</span>
        <h1>Markets</h1>
        <p>Trade stock-paired tokens, provide liquidity and earn trading fees.</p>
        <div className="exchange-actions"><Button asChild><Link href="/earn">View pools <ArrowUpRight /></Link></Button><Button asChild variant="outline"><Link href="/create"><Plus /> Launch token</Link></Button></div></div>
        <div className="exchange-feature"><span className="sr-eyebrow">FEATURED MARKET</span><div><TokenPair /></div><p>Stock-paired trading → fees → liquidity or holder rewards.</p><Link href="/onchain">Trade ROOM / mSPY <ArrowRight size={16}/></Link><small>Devnet · Markets that complete their curve graduate to their own DAMM v2 pool. The Earn pool is a separate, directly seeded pool.</small></div>
      </section>
      <section className="exchange-stock-section"><div className="nm-section-heading"><div><span className="sr-eyebrow">ASSETS</span><h2>Stock pools</h2></div><Link className="sr-text-link" href="/earn">All pools <ArrowUpRight size={16}/></Link></div>
      <div className="exchange-stocks">{[
        ["spy","SPYx","S&P 500","Broad market"], ["nvda","NVDAx","NVIDIA","Technology"], ["qqq","QQQx","Nasdaq 100","Growth"], ["tsla","TSLAx","Tesla","Consumer & energy"]
      ].map(([id,symbol,name,sector])=><Link key={id} href={`/vaults/${id}`} className="exchange-stock"><div className="exchange-stock-top"><TokenName symbol={symbol} size={36}/><ArrowUpRight size={18}/></div><h3>{name}</h3><p>{sector}</p><div className="exchange-stock-bottom"><span>Preview</span><span>Explore →</span></div></Link>)}</div></section>
      <div className="exchange-paths">{[
        ["/create","01","Launch","Configure a stock-paired DBC market."],
        ["/onchain","02","Trade","Inspect the market and its collected fees."],
        ["/earn","03","Provide liquidity","Deposit into the separate Devnet LP pool."],
        ["/rewards","04","Rewards","See eligibility, rounds and delivery receipts."]
      ].map(([url,n,title,copy])=><Link href={url} key={url}><span>{n}</span><div><strong>{title}</strong><p>{copy}</p></div><ArrowUpRight size={16}/></Link>)}</div>
      <section className="nm-markets" aria-labelledby="market-heading">
        <div className="nm-section-heading">
          <div>
            <span className="sr-eyebrow">THE MARKETPLACE</span>
            <h2 id="market-heading">Community markets.</h2>
            <p>
              Explore registered DBC markets. Community tokens are distinct from the stock tokens they trade against.
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
          <div className="nm-market-tab">
            All markets <span>{loading ? "…" : markets.length}</span>
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
        {error && <Alert className="mb-5"><AlertDescription>Market data is temporarily unavailable. You can still explore vault previews or retry using refresh.</AlertDescription></Alert>}
        <div className="nm-market-grid">
          {loading && !markets.length
            ? [1, 2].map((n) => (
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
            <Button variant="outline" onClick={() => setQuery("")}>
              Clear search
            </Button>
          </Card>
        )}
      </section>
      <div className="nm-bottom-note">
        <Layers3 size={20} />
        <div>
          <strong>Trading fees</strong>
          <p>
            Trading fees fund creator reserves. Creators choose liquidity or
            member rewards. Holding a community token does not give ownership of
            its reserve.
          </p>
        </div>
        <Link href="/capital" aria-label="Explore creator capital">
          <ArrowRight />
        </Link>
      </div>
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
    <Card className="sr-panel nm-market-card">
      <div className="sr-section-top">
        <div>
          <h3 className="token-title">
            <TokenImage profile={tokenProfile} symbol={m.symbol} size={32} />
            <TokenPair base={m.symbol} quote={quoteSymbolOf(m.quoteMint)} size={32} />
          </h3>
          <p className="sr-note font-bold">{m.name}</p>
          <TokenLinks profile={tokenProfile} />
        </div>
        <Badge variant="outline" className="nm-venue">
          {data?.migrated ? (
            "Graduated"
          ) : (
            <MeteoraLabel>Meteora DBC</MeteoraLabel>
          )}
        </Badge>
      </div>
      <GraduationProgress data={data} quote={quoteSymbolOf(m.quoteMint)} compact />
      <MarketStats pool={m.pool} quote={quoteSymbolOf(m.quoteMint)} />
      {m.mode === "floor" ? (
        <StockFloor data={data} market={m} quote={quoteSymbolOf(m.quoteMint)} compact />
      ) : (
      <div className="sr-detail-row">
        <span>Creator reserve</span>
        <strong>
          {data ? formatUnits(data.available) : "—"} <TokenName symbol={quoteSymbolOf(m.quoteMint)} />
        </strong>
      </div>
      )}
      <div className="sr-detail-row">
        <span>Lifetime collected fees</span>
        <strong>
          {data ? formatUnits(data.claimed) : "—"} <TokenName symbol={quoteSymbolOf(m.quoteMint)} />
        </strong>
      </div>
      <div className="sr-detail-row">
        <span>Community mint</span>
        <Address value={m.baseMint} />
      </div>
      <Failure text={error} />
      <Button asChild variant="outline" className="mt-4">
        <Link href={href(m)}>
          Open market
          <ArrowUpRight />
        </Link>
      </Button>
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
  useEffect(()=>{let active=true;const controller=new AbortController();setReferencePrice(null);const asset=({mSPY:'spy',mNVDA:'nvda',mQQQ:'qqq',mTSLA:'tsla'} as Record<string,string>)[settings.quote];fetch(`/api/token-market?asset=${asset}`,{signal:controller.signal}).then(async r=>{if(!r.ok)throw Error('Price unavailable');return await r.json() as {price:number;fetchedAt:string}}).then(d=>{if(active&&Number.isFinite(d.price)&&d.price>0)setReferencePrice({quote:settings.quote,price:d.price,at:d.fetchedAt})}).catch(()=>{});return()=>{active=false;controller.abort()}},[settings.quote]);
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
        description="Pair your token with mock stocks and collect trading fees. Launch on Solana Devnet."
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
                  void execute(async () =>
                    prepareLaunch(
                      address,
                      name.trim(),
                      symbol,
                      payout.trim() || address,
                      settings,
                      // Publish the profile first so its URI is fixed into the token's metadata.
                      hasProfile(profile)
                        ? await publishProfile(name.trim(), symbol, profile)
                        : "",
                    ),
                  )
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
            <strong>{(draft ? draft.mode==="floor" : settings.rewards==="treasury" && settings.floor) ? "50% recipient / 50% Stock Floor" : draft || settings.rewards==="treasury" ? "50% recipient / 50% creator reserve" : settings.rewards==="holders" ? "Holder rewards · preview" : "Liquidity · preview"}</strong>
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
