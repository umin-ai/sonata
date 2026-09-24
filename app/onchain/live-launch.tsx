"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { ArrowUpRight, Info } from "lucide-react";
import Link from "@/app/plain-link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TokenName, TokenPair } from "@/app/token-identity";
import { MeteoraLabel } from "@/app/protocol-identity";
import { initialSettings, priceLaunch, type LaunchSettings, type PythState } from "@/app/launch-settings";
import { TokenProfileFields, emptyProfile, hasProfile, publishProfile } from "@/app/token-profile-fields";
import { assessPrice, formatUsd, GRADUATION_USD, OPEN_USD, usdToQuote, type StockPrice } from "@/lib/pricing/stock-price";
import { previewDbc } from "@/lib/treasury/dbc-preview";
import { buyOut } from "@/lib/treasury/graduation";
import { isDeployableQuote, quoteAssetList, quoteSymbolOf } from "@/lib/treasury/quote-assets";
import {
  connection,
  explorer,
  prepareLaunch,
  prepareRegistration,
  validateMarketIdentity,
  type Market,
} from "@/lib/treasury/runtime";
import { normalizeLinks } from "@/lib/token-profile";
import { LiveWallet, useLive } from "./live-session";
import { WalletConnectButton } from "./wallet-connect";

// One-page launch. Name and ticker are the only required fields; everything else
// has a default: mSPY, 1.25% fee, graduation at $75K, creator and Sonata splitting
// the net fees, no first buy.
const NAME_RULE = /^[A-Za-z0-9][A-Za-z0-9 .-]{2,31}$/;
const TICKER_RULE = /^[A-Z][A-Z0-9]{1,9}$/;
const DEFAULT_TARGET_USD = 75_000;
// With no usable dollar price the curve is set in the stock token instead:
// opens at 2 and graduates at the same multiple as the dollar presets.
const FALLBACK_TARGET: Record<number, number> = { 25_000: 10, 50_000: 20, 75_000: 30 };
// Measured on Devnet: the config, pool and treasury transactions together.
const LAUNCH_COST_SOL = "≈ 0.032 SOL";
const FEES = [125, 200, 300];
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
// Share of each trade, like "0.5%": fee bps × share, trailing zeros dropped.
const pct = (bps: number) => `${Number((bps / 100).toFixed(3))}%`;
const compactUsd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(n);

// Per $1,000 traded: Meteora keeps 20% of the fee. Of the rest, half goes to the
// creator and half to Sonata; with the Stock Floor, the creator's half is split
// with the floor.
export function perThousand(feeBps: number, floor: boolean) {
  const traders = feeBps / 10;
  const meteora = traders * 0.2;
  const net = traders - meteora;
  return {
    traders,
    meteora,
    sonata: net / 2,
    creator: floor ? net / 4 : net / 2,
    floor: floor ? net / 4 : 0,
  };
}

export function LiveLaunch() {
  const { address, busy, pending, execute, revision } = useLive();
  const params = useSearchParams();
  const requested = params.get("quote");
  const [settings, setSettings] = useState<LaunchSettings>(() =>
    requested && isDeployableQuote(requested) ? { ...initialSettings, quote: requested } : initialSettings,
  );
  const [targetUsd, setTargetUsd] = useState(DEFAULT_TARGET_USD);
  const [devBuyText, setDevBuyText] = useState("");
  // Fee model: standard (creator earns), reward (holders earn), backed (a stock reserve).
  const model = settings.reward ? "reward" : settings.floor ? "backed" : "standard";
  // Switching model starts from the default 1.25% fee; More options can change it.
  const setModel = (m: "standard" | "reward" | "backed") =>
    setSettings((s) => ({ ...s, fee: 125, reward: m === "reward", floor: m === "backed" }));
  const [name, setName] = useState(""),
    [symbol, setSymbol] = useState(""),
    [payout, setPayout] = useState(""),
    [profile, setProfile] = useState(emptyProfile),
    [draft, setDraft] = useState<Market | null>(null),
    [exists, setExists] = useState<boolean | null>(null),
    [error, setError] = useState(""),
    [completed, setCompleted] = useState("");

  // Dollar price of the chosen stock: Jupiter on Solana, checked against Pyth.
  // Kept with the stock it belongs to, so a switch reads as loading, never stale.
  const [fetched, setFetched] = useState<{ quote: string; state: PythState } | null>(null);
  const pyth: PythState = fetched?.quote === settings.quote ? fetched.state : { status: "loading" };
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const quote = settings.quote;
    const setPyth = (state: PythState) => setFetched({ quote, state });
    fetch(`/api/stock-price?symbol=${settings.quote}`, { signal: controller.signal })
      .then(async (r) => {
        const d = (await r.json()) as { configured: false } | ({ configured: true; error?: string } & Partial<StockPrice>);
        if (!active) return;
        if (!d.configured) return setPyth({ status: "unconfigured" });
        if (!r.ok || d.error || typeof d.price !== "number")
          return setPyth({ status: "error", message: d.error ?? "Price unavailable." });
        const data = d as StockPrice;
        const a = assessPrice(data, Date.now());
        const guard = (d as { guard?: { feed: string; price: number; divergence: number } }).guard;
        setPyth(
          a.usable
            ? { status: "ok", data, label: a.label, live: a.live, confidenceRatio: a.confidenceRatio, guard }
            : { status: "unusable", message: a.reason, data },
        );
      })
      .catch(() => {
        if (active) setPyth({ status: "error", message: "Price unavailable." });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [settings.quote]);

  // The curve follows the price: dollar presets when the price is usable, stock-token
  // presets otherwise. Recomputed when the stock, target or price changes.
  const priced = pyth.status === "ok" ? pyth : null;
  const priceKey = priced ? `${priced.data.price}:${priced.data.publishTimeMs}` : pyth.status;
  useEffect(() => {
    if (pyth.status === "loading") return;
    setSettings((s) =>
      priced
        ? priceLaunch(s, targetUsd, priced)
        : { ...s, initial: 2, target: FALLBACK_TARGET[targetUsd], pricing: undefined },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceKey, targetUsd, settings.quote]);

  // Quote needed to graduate for each target, from Meteora's SDK, and each target's
  // curve for quoting a first buy.
  type Preview = Awaited<ReturnType<typeof previewDbc>>;
  const [previews, setPreviews] = useState<Record<number, Preview>>({});
  const raises = Object.fromEntries(
    Object.entries(previews).map(([usd, p]) => [usd, Number(p.quoteThreshold) / 1e8]),
  ) as Record<number, number>;
  const [curveError, setCurveError] = useState("");
  const unitPrice = settings.pricing?.price ?? null;
  useEffect(() => {
    if (pyth.status === "loading") return;
    let active = true;
    // The same conversions priceLaunch uses, so the preview matches what launches.
    const initial = unitPrice ? usdToQuote(OPEN_USD, unitPrice) : 2;
    void Promise.all(
      GRADUATION_USD.map(async (usd) => {
        const target = unitPrice ? usdToQuote(usd, unitPrice) : FALLBACK_TARGET[usd];
        const p = await previewDbc(initial, target, settings.fee);
        return [usd, p] as const;
      }),
    )
      .then((rows) => {
        if (active) {
          setPreviews(Object.fromEntries(rows));
          setCurveError("");
        }
      })
      .catch((e) => {
        if (active) setCurveError(e.message);
      });
    return () => {
      active = false;
    };
  }, [unitPrice, settings.fee, pyth.status]);

  // A launch saved in this browser whose treasury is not registered yet.
  const autoOpened = useRef("");
  const lastCompleted = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    setError("");
    try {
      const done = localStorage.getItem("stockroom.last-created") ?? "";
      // A launch just finished: clear the form so the same token is not launched twice.
      if (lastCompleted.current !== null && done && done !== lastCompleted.current) {
        setName("");
        setSymbol("");
        setProfile(emptyProfile);
      }
      lastCompleted.current = done;
      setCompleted(done);
      const raw = localStorage.getItem("stockroom.launch.draft");
      if (!raw) {
        setDraft(null);
        return;
      }
      const m = JSON.parse(raw) as Market;
      validateMarketIdentity(m);
      setDraft(m);
      setExists(null);
      // The public RPC can lag just after creation: look three times before
      // concluding the pool does not exist.
      void (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const info = await connection.getAccountInfo(new PublicKey(m.pool)).catch(() => null);
          if (!active) return;
          if (info) return setExists(true);
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (active) setExists(false);
      })();
    } catch {
      setError("Saved launch is invalid. It has not been used to construct a transaction.");
    }
    return () => {
      active = false;
    };
  }, [revision]);

  const enabled = !!address && !busy && !pending;
  // Open the second approval by itself once the pool exists.
  useEffect(() => {
    if (!draft || !exists || !enabled || address !== draft.creator || autoOpened.current === draft.pool) return;
    // A launch bundle registers the treasury itself; only reopen for a draft still saved.
    try {
      if (!localStorage.getItem("stockroom.launch.draft")) return;
    } catch {
      return;
    }
    autoOpened.current = draft.pool;
    void execute(() => prepareRegistration(address, draft));
  }, [draft, exists, enabled, address, execute]);

  const nameOk = NAME_RULE.test(name.trim());
  const tickerOk = TICKER_RULE.test(symbol);
  let linksOk = true;
  try {
    normalizeLinks(profile);
  } catch {
    linksOk = false;
  }
  let payoutOk = true;
  if (payout.trim())
    try {
      new PublicKey(payout.trim());
    } catch {
      payoutOk = false;
    }
  const ready = pyth.status !== "loading" && raises[targetUsd] !== undefined;
  // Dev buy preview on the chosen curve, with the same math the launch uses.
  const devBuy = Number(devBuyText || 0);
  let devBuyOk = Number.isFinite(devBuy) && devBuy >= 0,
    devBuyProblem = "Enter an amount, like 2.5.",
    devBuyTokens: { tokens: number; percent: number } | null = null;
  const preview = previews[targetUsd];
  if (devBuyOk && devBuy > 0 && preview) {
    const quote = buyOut(
      BigInt(Math.round(devBuy * 1e8)),
      settings.fee,
      BigInt(preview.sqrtStartPrice),
      preview.curve.map((c) => ({ sqrtPrice: BigInt(c.sqrtPrice), liquidity: BigInt(c.liquidity) })),
    );
    const percent = Number((quote.out * 10_000n) / 10n ** 15n) / 100;
    if (quote.unspent > 0n) {
      devBuyOk = false;
      devBuyProblem = "That is more than the whole curve. Buy less.";
    } else if (percent > 75) {
      devBuyOk = false;
      devBuyProblem = "A first buy can take at most 75% of the supply. Buy less.";
    } else devBuyTokens = { tokens: Number(quote.out) / 1e6, percent };
  }
  const blocked = !nameOk
    ? "Add a token name to launch."
    : !tickerOk
      ? "Add a ticker to launch."
      : !linksOk
        ? "Fix the links above to launch."
        : !payoutOk
          ? "Check the payout wallet under More options."
          : !devBuyOk
            ? "Check your first buy."
          : !ready
            ? "Loading the stock price…"
            : busy || pending
              ? "Waiting for the previous transaction…"
              : "";
  const q = settings.quote;
  const raiseQuote = raises[targetUsd];
  const raiseText =
    raiseQuote === undefined
      ? "—"
      : unitPrice
        ? `≈ ${compactUsd(raiseQuote * unitPrice)}`
        : `${raiseQuote.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${q}`;
  const payTo = payout.trim() || address;

  const launch = () =>
    void execute(async () => {
      const go = (uri: string) =>
        prepareLaunch(address, name.trim(), symbol, payout.trim() || address, { ...settings, reward: model === "reward", devBuy: devBuy || 0 }, uri);
      // Publish the metadata first so its URI is fixed into the token. Every launch
      // gets one, naming Sonata. Without a profile it is optional: a failed upload,
      // or a name too long to fit a URI in the transaction, launches with no URI.
      if (hasProfile(profile)) return go(await publishProfile(name.trim(), symbol, profile));
      const uri = await publishProfile(name.trim(), symbol, profile).catch(() => "");
      return go(uri).catch((e: Error) => {
        if (uri && /Shorten the token name/.test(e.message)) return go("");
        throw e;
      });
    });

  return (
    <>
      <div className="sr-heading">
        <div>
          <span className="sr-eyebrow">SONATA</span>
          <h1>Launch your token</h1>
          <p>Launch a token paired with a stock.</p>
        </div>
      </div>
      <LiveWallet />
      {error && (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {completed && !draft && (
        <Alert className="mb-5">
          <AlertDescription>
            Your latest market is live.{" "}
            <Link className="underline" href={`/onchain?pool=${completed}`}>
              Open it and make the first trade →
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {draft ? (
        <Card className="sr-panel launch-form launch-finish">
          <span className="sr-eyebrow">FINISH LAUNCH</span>
          <h3>
            <TokenPair base={draft.symbol} quote={quoteSymbolOf(draft.quoteMint)} />
          </h3>
          <p className="sr-note">
            Your pool is live, but payouts are off until you approve this. Your fees are kept until then.
          </p>
          <div className="sr-detail-row">
            <span>Pool</span>
            <a className="sr-text-link" href={explorer("address", draft.pool)} target="_blank" rel="noreferrer">
              {short(draft.pool)} <ArrowUpRight size={13} />
            </a>
          </div>
          <div className="sr-detail-row">
            <span>Pays to</span>
            <strong>{short(draft.payoutOwner)}</strong>
          </div>
          <Button
            disabled={!enabled || !exists || address !== draft.creator}
            onClick={() => void execute(() => prepareRegistration(address, draft))}
          >
            Turn on payouts
          </Button>
          {address && address !== draft.creator && (
            <p className="sr-note">Reconnect the wallet that launched this token to finish.</p>
          )}
          {exists === null && <p className="sr-note">Checking the pool on Solana Devnet…</p>}
          {exists === false && !pending && (
            <>
              <p className="sr-note">
                The pool was not found after three checks. If the launch transaction expired, discard this draft to
                start again. If you just launched, wait a few seconds and refresh first.
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
        </Card>
      ) : (
        <div className="launch-workspace launch-one-page">
          <Card className="sr-panel launch-form">
            <section className="launch-section">
              <span className="sr-eyebrow">1 · FEE MODEL</span>
              <div className="segmented" role="radiogroup" aria-label="Fee model">
                {(
                  [
                    ["standard", "Standard token"],
                    ["reward", "Reward token"],
                    ["backed", "Backed token"],
                  ] as const
                ).map(([key, title]) => (
                  <button type="button" role="radio" key={key} aria-checked={model === key} onClick={() => setModel(key)}>
                    {title}
                  </button>
                ))}
              </div>
              {model !== "backed" && (
                <>
                  <Label>Holder rewards</Label>
                  <div className="segmented" role="radiogroup" aria-label="Holder rewards">
                    {([0, 125, 300] as const).map((fee) => (
                      <button
                        type="button"
                        role="radio"
                        key={fee}
                        aria-checked={fee === 0 ? model === "standard" : model === "reward" && settings.fee === fee}
                        onClick={() =>
                          fee === 0
                            ? setModel("standard")
                            : setSettings((s) => ({ ...s, fee, reward: true, floor: false }))
                        }
                      >
                        {fee === 0 ? "None" : pct(fee * 0.4)}
                      </button>
                    ))}
                  </div>
                  <p className="sr-note">
                    {model === "reward"
                      ? "Paid to holders from every trade. No extra tax."
                      : "A standard token has no holder rewards. Pick a rate to launch a reward token instead."}
                  </p>
                </>
              )}
              <p className="launch-info">
                <Info size={16} />
                <span>
                  Your token launches on a Meteora bonding curve and graduates into a Meteora pool at{" "}
                  {compactUsd(targetUsd)}.{" "}
                  {model === "reward"
                    ? `${pct(settings.fee * 0.4)} of every trade is paid to holders automatically, in ${q}. There is no separate creator fee; the creator is treated like any other holder.`
                    : model === "backed"
                      ? `You earn ${pct(settings.fee * 0.2)} of every trade. Another ${pct(settings.fee * 0.2)} builds a ${q} reserve that backs every token: holders can cash out for their share any time.`
                      : `You earn ${pct(settings.fee * 0.4)} of every trade, sent to your wallet in ${q} automatically, and half of the locked pool after graduation.`}
                </span>
              </p>
            </section>

            <section className="launch-section">
              <span className="sr-eyebrow">2 · YOUR TOKEN</span>
              <div>
                <Label htmlFor="market-name">Token name</Label>
                <Input
                  id="market-name"
                  value={name}
                  maxLength={32}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your community"
                  aria-invalid={!!name && !nameOk}
                />
                {name && !nameOk && (
                  <p className="sr-note text-destructive" role="alert">
                    Use 3–32 characters: letters, numbers, spaces, dots or hyphens.
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="market-symbol">Ticker</Label>
                <Input
                  id="market-symbol"
                  value={symbol}
                  maxLength={10}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                  placeholder="CREW"
                  aria-invalid={!!symbol && !tickerOk}
                />
                {symbol && !tickerOk && (
                  <p className="sr-note text-destructive" role="alert">
                    Use 2–10 letters or numbers, starting with a letter.
                  </p>
                )}
              </div>
              <TokenProfileFields value={profile} onChange={setProfile} />
            </section>

            <section className="launch-section">
              <span className="sr-eyebrow">3 · PAIR IT WITH A STOCK</span>
              <p className="sr-note">You earn in the stock you pick.</p>
              <div className="launch-options">
                {quoteAssetList.map((a) => (
                  <button
                    type="button"
                    key={a.symbol}
                    aria-pressed={settings.quote === a.symbol}
                    onClick={() => setSettings((s) => ({ ...s, quote: a.symbol, pricing: undefined }))}
                  >
                    <TokenName symbol={a.symbol} size={28} />
                    <span>{a.name}</span>
                    {a.symbol === "mANTHROPIC" && <small>Pre-IPO · PreStocks</small>}
                  </button>
                ))}
              </div>
              <p className="sr-note" role="status">
                {pyth.status === "loading"
                  ? "Loading the stock price…"
                  : priced
                    ? `${q.slice(1)} ${formatUsd(priced.data.price)} · ${priced.data.source === "pyth" ? "Pyth" : "Jupiter"}${priced.guard ? " · checked by Pyth" : ""}`
                    : `Dollar price unavailable right now, so the curve is set in ${q}: opens at 2 ${q}, graduates at ${FALLBACK_TARGET[targetUsd]} ${q}.`}
              </p>
            </section>

            <section className="launch-section">
              <span className="sr-eyebrow">4 · BUY FIRST (OPTIONAL)</span>
              <div>
                <Label htmlFor="dev-buy">Your first buy, in {q}</Label>
                <Input
                  id="dev-buy"
                  inputMode="decimal"
                  value={devBuyText}
                  onChange={(e) => setDevBuyText(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder="0"
                  aria-invalid={!devBuyOk}
                />
                <p className={devBuyOk ? "sr-note" : "sr-note text-destructive"} role="status">
                  {!devBuyOk
                    ? devBuyProblem
                    : devBuyTokens
                      ? `≈ ${devBuyTokens.percent.toFixed(2)}% of the supply (${Math.round(devBuyTokens.tokens).toLocaleString()} ${symbol || "tokens"}), bought before anyone else.`
                      : "Optional. Up to 75% of supply, bought as the very first trade so nothing trades before you."}
                </p>
              </div>
            </section>

            <details className="launch-disclosure launch-more">
              <summary>
                More options · {settings.fee / 100}% fee · graduates at {compactUsd(targetUsd)}
                {model !== "reward" && payTo ? ` · pays to ${short(payTo)}` : ""}
              </summary>
              <fieldset>
                <legend>Trading fee</legend>
                <div className="curve-presets">
                  {FEES.map((fee) => (
                    <button
                      type="button"
                      key={fee}
                      aria-pressed={settings.fee === fee}
                      onClick={() => setSettings((s) => ({ ...s, fee }))}
                    >
                      <strong>{fee / 100}%</strong>
                      <span>you {pct(fee * (settings.floor ? 0.2 : 0.4))}</span>
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>Graduates at</legend>
                <div className="curve-presets">
                  {GRADUATION_USD.map((usd) => (
                    <button type="button" key={usd} aria-pressed={targetUsd === usd} onClick={() => setTargetUsd(usd)}>
                      <strong>{compactUsd(usd)}</strong>
                      <span>
                        {raises[usd] === undefined
                          ? "—"
                          : unitPrice
                            ? `raises ≈ ${compactUsd(raises[usd] * unitPrice)}`
                            : `${FALLBACK_TARGET[usd]} ${q} market cap`}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="sr-note">Opens at {formatUsd(OPEN_USD)}. Liquidity is locked forever at graduation.</p>
              </fieldset>
              {model !== "reward" && <div>
                <Label htmlFor="payout-wallet">Payout wallet</Label>
                <Input
                  id="payout-wallet"
                  value={payout}
                  onChange={(e) => setPayout(e.target.value)}
                  placeholder={address || "Your connected wallet"}
                  aria-invalid={!payoutOk}
                />
                <p className={payoutOk ? "sr-note" : "sr-note text-destructive"}>
                  {payoutOk ? "Fixed at launch. Leave blank for your wallet." : "Not a Solana address."}
                </p>
              </div>}
            </details>
            <p className="sr-note mt-3">
              <MeteoraLabel>Powered by Meteora</MeteoraLabel>
            </p>
          </Card>

          <Card className="sr-panel launch-summary">
            <span className="sr-eyebrow">YOUR LAUNCH</span>
            <h3>
              <TokenPair base={symbol || "TOKEN"} quote={q} />
            </h3>
            <p className="sr-note">{name.trim() || "Your token name"}</p>
            {(
              [
                ["Fee model", model === "reward" ? "Reward token" : model === "backed" ? "Backed token" : "Standard token"],
                ["Pair", q],
                [
                  "Graduates at",
                  `${settings.pricing ? compactUsd(settings.pricing.targetUsd) : `${settings.target} ${q}`}${raiseText !== "—" ? ` · ${raiseText} raised` : ""}`,
                ],
                ["Supply", "1 billion"],
                ["Trading fee", pct(settings.fee)],
                ["Fee → creator", model === "reward" ? "None" : pct(settings.fee * (model === "backed" ? 0.2 : 0.4))],
                [
                  "Fee → holders",
                  model === "reward"
                    ? `${pct(settings.fee * 0.4)} · paid out`
                    : model === "backed"
                      ? `${pct(settings.fee * 0.2)} · as backing`
                      : "None",
                ],
                ["Fee → Sonata", pct(settings.fee * 0.4)],
                ["Fee → Meteora", pct(settings.fee * 0.2)],
                ["After graduation → creator", "Half the locked pool"],
                ...(devBuyTokens ? [["First buy", `${devBuy} ${q} · ≈ ${devBuyTokens.percent.toFixed(2)}%`]] : []),
                ["Launch cost", `${LAUNCH_COST_SOL} · rent only`],
              ] as [string, string][]
            ).map(([label, value]) => (
              <div className="sr-detail-row" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
            {curveError && (
              <p className="sr-note text-destructive" role="alert">
                {curveError}
              </p>
            )}
            {!address ? (
              <WalletConnectButton />
            ) : (
              <Button disabled={!!blocked || !enabled} onClick={launch}>
                Launch {symbol || "token"}
              </Button>
            )}
            <p className="sr-note">
              {blocked ||
                `One approval${devBuyTokens ? `, plus ${devBuy} ${q} for your first buy` : ""}. Test tokens on Solana Devnet have no value.`}
            </p>
          </Card>
        </div>
      )}
    </>
  );
}
