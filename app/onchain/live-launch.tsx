"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { ArrowUpRight, Flame, Gem, Info, Split, Sprout, Trophy, Wallet, X } from "lucide-react";
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
import {
  assessPrice,
  formatUsd,
  GRADUATION_USD,
  OPEN_USD,
  STOCK_FAMILIES,
  stockFamily,
  usdToQuote,
  type StockPrice,
} from "@/lib/pricing/stock-price";
import { AIRDROP_PERCENT, previewDbc, type CurveShape } from "@/lib/treasury/dbc-preview";
import { buyOut, quoteForOut } from "@/lib/treasury/graduation";
import { isDeployableQuote, quoteAssetList, quoteSymbolOf } from "@/lib/treasury/quote-assets";
import {
  REWARDS_WALLET,
  connection,
  explorer,
  prepareLaunch,
  prepareRegistration,
  validateMarketIdentity,
  type FeeModule,
  type Market,
} from "@/lib/treasury/runtime";
import { MAX_SPLIT, normalizeLinks, type FeeModel } from "@/lib/token-profile";
import { PAYOUT_BOT_V2 } from "@/lib/features";
import { LiveWallet, useLive } from "./live-session";
import { WalletConnectButton } from "./wallet-connect";

// Five-step launch, like Ember's: token (with the dev buy), pair, curve, fee model,
// review. Name and ticker are the only required fields; everything else has a
// default: mSPY, 1.25% fee, graduation at $75K, a Standard token, no dev buy.
const NAME_RULE = /^[A-Za-z0-9][A-Za-z0-9 .-]{2,31}$/;
const TICKER_RULE = /^[A-Z][A-Z0-9]{1,9}$/;
const DEFAULT_TARGET_USD = 75_000;
// With no usable dollar price the curve is set in the stock token instead:
// opens at 2 and graduates at the same multiple as the dollar presets.
const FALLBACK_TARGET: Record<number, number> = { 25_000: 10, 50_000: 20, 75_000: 30 };
// Measured on Devnet: the config, pool and treasury transactions together.
const LAUNCH_COST_SOL = "≈ 0.032 SOL";
const FEES: [number, string][] = [
  [125, "standard"],
  [200, "more payouts"],
  [300, "max payouts"],
];
const GRADUATION_NOTE: Record<number, string> = {
  25_000: "fast · smallest raise",
  50_000: "balanced",
  75_000: "deepest liquidity",
};
const MAX_DEV_BUY_PERCENT = 75;
const SUPPLY_ATOMS = 10n ** 15n; // 1 billion tokens, 6 decimals
const STEPS: [string, string][] = [
  ["Token", "name, ticker, image"],
  ["Pair", "stock & dev buy"],
  ["Curve", "graduation & fee"],
  ["Fee model", "where your share goes"],
  ["Review", "one approval"],
];
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
// Share of each trade, like "0.5%": fee bps × share, trailing zeros dropped.
const pct = (bps: number) => `${Number((bps / 100).toFixed(3))}%`;
const compactUsd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
const amount = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 4 : 2 });

type Model = "standard" | "reward" | "backed";
// Where a Standard token's 0.5% goes: the creator ("keep"), or a module run by
// Sonata's payout bot.
type Destination = "keep" | FeeModule;
const DESTINATIONS: { key: Destination; title: string; line: string; icon: typeof Wallet }[] = [
  { key: "keep", title: "Keep it", line: "Paid to you", icon: Wallet },
  { key: "buyback", title: "Buyback & burn", line: "Buys your token and burns it", icon: Flame },
  { key: "topBuyers", title: "Top Buyer Bounty", line: "Top 3 buyers win each round", icon: Trophy },
  { key: "lpFarm", title: "LP Farm", line: "Holders, then liquidity providers", icon: Sprout },
  { key: "split", title: "Split", line: `Up to ${MAX_SPLIT} wallets`, icon: Split },
  { key: "diamond", title: "Diamond Hands", line: "Holders, more the longer they hold", icon: Gem },
];
const SHAPES: [CurveShape, string, string][] = [
  ["classic", "Classic", "Meteora's standard curve. The price moves evenly at every stage."],
  ["steady", "Steady", "A little livelier at the start, a deeper pool at graduation."],
  ["rocket", "Rocket", "Small buys move it fast early, the end is slow, the deepest pool."],
  ["whaleWall", "Whale wall", "Big early buys barely move it, then it sprints; the thinnest pool."],
];

// Per $1,000 traded: Meteora takes 20% of the fee (a fifth of it back to Sonata as referrer on site swaps). Of the rest, half goes to the
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
  // Quick launch: the default bonding curve, one screen. Advanced: the five steps.
  const [quick, setQuick] = useState(true);
  const [step, setStep] = useState(0);
  const stepsRef = useRef<HTMLElement>(null);
  const go = (n: number) => {
    setStep(n);
    // On a phone the steps sit above the form: bring them back into view.
    const top = stepsRef.current?.getBoundingClientRect().top ?? 0;
    if (top < 0) stepsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const [settings, setSettings] = useState<LaunchSettings>(() =>
    requested && isDeployableQuote(requested) ? { ...initialSettings, quote: requested } : initialSettings,
  );
  const [targetUsd, setTargetUsd] = useState(DEFAULT_TARGET_USD);
  // Stock picker tab (xStocks, PreStocks), opening on the chosen stock's family.
  const [pairTab, setPairTab] = useState(() => stockFamily(settings.quote));
  // Fee model: standard (creator earns, or a module), reward (holders earn), backed (a stock reserve).
  const model: Model = settings.reward ? "reward" : settings.floor ? "backed" : "standard";
  const [destination, setDestination] = useState<Destination>("keep");
  const feeModule: FeeModule | undefined = model === "standard" && destination !== "keep" ? destination : undefined;
  const setModel = (m: Model) => {
    setSettings((s) => ({ ...s, reward: m === "reward", floor: m === "backed" }));
    if (m !== "standard") setDestination("keep");
  };
  const pickDestination = (d: Destination) => {
    setSettings((s) => ({ ...s, reward: false, floor: false }));
    setDestination(d);
    // A split starts with the creator's own wallet, ready to add others.
    if (d === "split" && address)
      setSplit((rows) => (rows.length === 1 && !rows[0].wallet.trim() ? [{ wallet: address, weight: "100" }] : rows));
  };
  // Quick launch always uses the defaults, so switching to it resets any advanced choice.
  const switchMode = (toQuick: boolean) => {
    if (toQuick) {
      setSettings((s) => ({
        ...s,
        fee: initialSettings.fee,
        reward: false,
        floor: false,
        shape: undefined,
        volatility: false,
        airdrop: false,
      }));
      setDestination("keep");
      setTargetUsd(DEFAULT_TARGET_USD);
      setPayout("");
    } else setStep(0);
    setQuick(toQuick);
  };
  const [split, setSplit] = useState<{ wallet: string; weight: string }[]>([{ wallet: "", weight: "100" }]);
  // Dev buy, set as a share of supply (like StonkFun's default) or as an amount of the stock.
  const [devBuyMode, setDevBuyMode] = useState<"percent" | "amount">("percent");
  const [devBuyPercent, setDevBuyPercent] = useState(0);
  const [devBuyText, setDevBuyText] = useState("");
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
        const d = (await r.json()) as
          { configured: false } | ({ configured: true; error?: string } & Partial<StockPrice>);
        if (!active) return;
        if (!d.configured) return setPyth({ status: "unconfigured" });
        if (!r.ok || d.error || typeof d.price !== "number")
          return setPyth({ status: "error", message: d.error ?? "Price unavailable." });
        const data = d as StockPrice;
        const a = assessPrice(data, Date.now());
        const guard = (d as { guard?: { feed: string; price: number; divergence: number } }).guard;
        const mark = (d as { mark?: { price: number; premium: number | null } }).mark;
        setPyth(
          a.usable
            ? { status: "ok", data, label: a.label, live: a.live, confidenceRatio: a.confidenceRatio, guard, mark }
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
  // curve for quoting a dev buy.
  const curveOptions = { shape: settings.shape, volatility: settings.volatility, airdrop: settings.airdrop };
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
        const p = await previewDbc(initial, target, settings.fee, curveOptions);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitPrice, settings.fee, pyth.status, settings.shape, settings.volatility, settings.airdrop]);

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
        setDevBuyPercent(0);
        setDevBuyText("");
        setStep(0);
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
  // Split: normal wallets only, each once, never Sonata's payout bot, whole-number shares.
  const splitRows = split.map((r) => {
    const wallet = r.wallet.trim(),
      weight = Number(r.weight);
    let ok = false;
    try {
      ok = PublicKey.isOnCurve(new PublicKey(wallet).toBytes()) && wallet !== REWARDS_WALLET;
    } catch {
      ok = false;
    }
    return { wallet, weight, walletOk: ok, weightOk: Number.isInteger(weight) && weight >= 1 && weight <= 100 };
  });
  const splitTotal = splitRows.reduce((t, r) => t + (r.weightOk ? r.weight : 0), 0);
  const splitOk =
    splitRows.length >= 1 &&
    splitRows.every((r) => r.walletOk && r.weightOk) &&
    new Set(splitRows.map((r) => r.wallet)).size === splitRows.length;

  const ready = pyth.status !== "loading" && raises[targetUsd] !== undefined;
  const q = settings.quote;
  const preview = previews[targetUsd];
  const curvePoints = preview?.curve.map((c) => ({ sqrtPrice: BigInt(c.sqrtPrice), liquidity: BigInt(c.liquidity) }));
  const sqrtStart = preview ? BigInt(preview.sqrtStartPrice) : 0n;
  const threshold = preview ? BigInt(preview.quoteThreshold) : 0n;
  // The largest dev buy on this curve: 75% of supply, or less when the curve would
  // otherwise fill and graduate the token at launch (the $25K curve sells about 69%).
  let maxPercent = MAX_DEV_BUY_PERCENT,
    soldPercent: number | null = null;
  // Share of supply a dollar amount buys on the fresh curve, like Ember's "$100 buys".
  const buysPercent = (usd: number) =>
    preview && curvePoints && unitPrice
      ? Number(
          (buyOut(BigInt(Math.round((usd / unitPrice) * 1e8)), settings.fee, sqrtStart, curvePoints).out * 10_000n) /
            SUPPLY_ATOMS,
        ) / 100
      : null;
  if (preview && curvePoints) {
    const gross = (threshold * 1_000_000_000n) / (1_000_000_000n - BigInt(settings.fee) * 100_000n);
    soldPercent = Number((buyOut(gross, settings.fee, sqrtStart, curvePoints).out * 10_000n) / SUPPLY_ATOMS) / 100;
    maxPercent = Math.min(MAX_DEV_BUY_PERCENT, Math.floor((soldPercent - 0.5) * 2) / 2);
  }
  const maxQuote =
    preview && curvePoints
      ? quoteForOut(
          (SUPPLY_ATOMS * BigInt(Math.round(maxPercent * 100))) / 10_000n,
          settings.fee,
          sqrtStart,
          curvePoints,
        )
      : null;
  // The dev buy in stock atoms, from whichever input is in use.
  let devBuyAtoms = 0n,
    devBuyOk = true,
    devBuyProblem = "";
  if (devBuyMode === "percent") {
    if (devBuyPercent > 0 && preview && curvePoints) {
      const tokens = (SUPPLY_ATOMS * BigInt(Math.round(Math.min(devBuyPercent, maxPercent) * 100))) / 10_000n;
      devBuyAtoms = quoteForOut(tokens, settings.fee, sqrtStart, curvePoints) ?? 0n;
    }
  } else {
    const n = Number(devBuyText || 0);
    if (!Number.isFinite(n) || n < 0) {
      devBuyOk = false;
      devBuyProblem = "Enter an amount, like 2.5.";
    } else devBuyAtoms = BigInt(Math.round(n * 1e8));
  }
  let devBuyTokens: { tokens: number; percent: number } | null = null;
  if (devBuyOk && devBuyAtoms > 0n && preview && curvePoints) {
    const quote = buyOut(devBuyAtoms, settings.fee, sqrtStart, curvePoints);
    const percent = Number((quote.out * 10_000n) / SUPPLY_ATOMS) / 100;
    if (quote.unspent > 0n || devBuyAtoms - quote.fee >= threshold || percent > maxPercent) {
      devBuyOk = false;
      devBuyProblem = `That buys more than ${maxPercent}% of the supply${maxPercent < MAX_DEV_BUY_PERCENT ? " and would graduate the token at launch" : ""}. Buy less.`;
    } else devBuyTokens = { tokens: Number(quote.out) / 1e6, percent };
  }
  const devBuy = Number(devBuyAtoms) / 1e8;

  // What still stops a launch, and the step that fixes it.
  const problems: [string, number][] = [
    ...(!nameOk ? [["Add a token name.", 0] as [string, number]] : []),
    ...(!tickerOk ? [["Add a ticker.", 0] as [string, number]] : []),
    ...(!linksOk ? [["Fix the links.", 0] as [string, number]] : []),
    ...(!devBuyOk ? [["Check your dev buy.", 1] as [string, number]] : []),
    ...(feeModule === "split" && !splitOk ? [["Check the split wallets.", 3] as [string, number]] : []),
    ...(!feeModule && model !== "reward" && !payoutOk ? [["Check the payout wallet.", 3] as [string, number]] : []),
  ];
  const blocked = problems.length
    ? problems[0][0]
    : !ready
      ? "Loading the stock price…"
      : busy || pending
        ? "Waiting for the previous transaction…"
        : "";
  const raiseQuote = raises[targetUsd];
  const raiseText =
    raiseQuote === undefined
      ? "—"
      : unitPrice
        ? `≈ ${compactUsd(raiseQuote * unitPrice)}`
        : `${amount(raiseQuote)} ${q}`;
  const payTo = payout.trim() || address;
  const share = pct(settings.fee * 0.4),
    half = pct(settings.fee * 0.2);
  const feeModel: FeeModel = feeModule ?? (model === "reward" ? "holders" : model);
  const modelName = [
    model === "reward" ? "Reward token" : model === "backed" ? "Backed token" : "Standard token",
    ...(feeModule ? [DESTINATIONS.find((d) => d.key === feeModule)!.title] : []),
  ].join(" · ");
  const curveText = `${settings.pricing ? compactUsd(OPEN_USD) : `2 ${q}`} → ${settings.pricing ? compactUsd(settings.pricing.targetUsd) : `${settings.target} ${q}`}`;

  // One line on what the chosen model does with its share.
  const modelInfo =
    model === "reward"
      ? `${share} of every trade is paid to holders, pro rata, in ${q}. No transfer tax. Your own wallet is left out, dev buy included.`
      : model === "backed"
        ? `You earn ${half} of every trade. Another ${half} builds a ${q} reserve behind every token: any holder can cash out their share, and you can never touch it.`
        : feeModule === "buyback"
          ? `${share} of every trade buys your token and burns it. On the curve first, then in the Meteora pool after graduation. Burned supply shows on the token page.`
          : feeModule === "topBuyers"
            ? `${share} of every trade goes to the 3 biggest net buyers of each 15-minute round: 50% / 30% / 20%. Net = buys − sells, so sellers can't game it. You and Sonata are excluded. A round with no net buyers rolls over.`
            : feeModule === "lpFarm"
              ? `${share} of every trade goes to holders while on the curve, then to liquidity providers in the Meteora pool after graduation, pro rata. Liquidity counts once it has been in the pool for a full round. Your own wallet is left out.`
              : feeModule === "split"
                ? `${share} of every trade is split between these wallets by share, in ${q}.`
                : feeModule === "diamond"
                  ? `${share} of every trade goes to holders, weighted by how long they've held: 1× on day one, 1.5× after 24 hours, 2× after 3 days, 3× after 7 days. Selling or moving tokens restarts the clock for that amount, and new tokens start at 1×. Your own wallet is left out.`
                  : `You earn ${share} of every trade, paid to your wallet in ${q}. Nothing to claim.`;
  const cadence =
    feeModule === "buyback"
      ? "Burning every 15 min"
      : feeModule === "topBuyers"
        ? "Rewarding buyers every 15 min"
        : feeModule === "lpFarm"
          ? "Paying every 15 min"
          : feeModule === "split"
            ? "Splitting every 15 min"
            : feeModule === "diamond"
              ? "Paying diamond hands every 15 min"
              : model === "reward"
                ? "Paying holders every 15 min"
                : "Paying you every 15 min";
  const shareRows: [string, string][] =
    model === "reward"
      ? [
          ["Fee → creator", "None"],
          ["Fee → holders", share],
        ]
      : model === "backed"
        ? [
            ["Fee → creator", half],
            ["Fee → backing", half],
          ]
        : feeModule
          ? [
              ["Fee → creator", "None"],
              [
                feeModule === "buyback"
                  ? "Fee → buyback & burn"
                  : feeModule === "topBuyers"
                    ? "Fee → top 3 buyers"
                    : feeModule === "lpFarm"
                      ? "Fee → holders, then LPs"
                      : feeModule === "diamond"
                        ? "Fee → long-term holders"
                        : `Fee → ${splitRows.length} wallet${splitRows.length === 1 ? "" : "s"}`,
                share,
              ],
            ]
          : [["Fee → creator", share]];

  const launch = () =>
    void execute(async () => {
      const send = (uri: string) =>
        prepareLaunch(
          address,
          name.trim(),
          symbol,
          payout.trim() || address,
          { ...settings, reward: model === "reward", module: feeModule, devBuy },
          uri,
        );
      // Publish the metadata first so its URI is fixed into the token. It names Sonata
      // and the fee model. A profile or a fee module needs it; otherwise it is optional:
      // a failed upload, or a name too long to fit a URI in the transaction, launches
      // with no URI.
      const publish = () =>
        publishProfile(
          name.trim(),
          symbol,
          profile,
          feeModel,
          feeModule === "split" ? splitRows.map(({ wallet, weight }) => ({ wallet, weight })) : undefined,
        );
      if (hasProfile(profile) || feeModule) return send(await publish());
      const uri = await publish().catch(() => "");
      return send(uri).catch((e: Error) => {
        if (uri && /Shorten the token name/.test(e.message)) return send("");
        throw e;
      });
    });

  const tokenSection = (
    <section className="launch-section">
      <h3>Your token</h3>
      <p className="sr-note">
        Name, ticker and image. Supply is fixed at 1 billion. You can&apos;t change these later.
      </p>
      <div>
        <Label htmlFor="market-name">Token name</Label>
        <Input
          id="market-name"
          value={name}
          maxLength={32}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Nasdoge"
          aria-invalid={!!name && !nameOk}
        />
        {name && !nameOk && (
          <p className="sr-note text-destructive" role="alert">
            Use 3–32 letters, numbers, spaces, dots or hyphens.
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
          placeholder="e.g. NDOGE"
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
  );
  const pairSection = (
    <section className="launch-section">
      <h3>Pair with</h3>
      <p className="sr-note">Your token trades against this stock, and every fee is paid in it.</p>
      <div className="pair-tabs" role="tablist" aria-label="Stock family">
        {STOCK_FAMILIES.map((family) => (
          <button
            type="button"
            role="tab"
            key={family}
            aria-selected={pairTab === family}
            onClick={() => setPairTab(family)}
          >
            {family}
            <span>{quoteAssetList.filter((a) => stockFamily(a.symbol) === family).length}</span>
          </button>
        ))}
      </div>
      <div className="launch-options pair-options" role="tabpanel" aria-label={pairTab}>
        {quoteAssetList
          .filter((a) => stockFamily(a.symbol) === pairTab)
          .map((a) => (
            <button
              type="button"
              key={a.symbol}
              aria-pressed={settings.quote === a.symbol}
              title={a.symbol === "mANTHROPIC" ? "Pre-IPO Anthropic, priced from PreStocks on Solana" : undefined}
              onClick={() => setSettings((s) => ({ ...s, quote: a.symbol, pricing: undefined }))}
            >
              <TokenName symbol={a.symbol} size={20} />
              <span>{a.name}</span>
            </button>
          ))}
      </div>
      <p className="sr-note" role="status">
        {pyth.status === "loading"
          ? "Loading the stock price…"
          : priced
            ? `${q.slice(1)} ${formatUsd(priced.data.price)} · ${priced.data.source === "pyth" ? "Pyth" : priced.data.source === "prestocks" ? "PreStocks mark price (the Solana market is too thin)" : "Jupiter"}${priced.guard ? " · checked by Pyth" : ""}${priced.mark && priced.mark.premium !== null ? ` · ${Math.abs(priced.mark.premium * 100).toFixed(1)}% ${priced.mark.premium >= 0 ? "above" : "below"} PreStocks' mark (${formatUsd(priced.mark.price)})` : ""}. Prices are converted at launch, so the curve is worth the same in dollars whatever the stock.`
            : `Dollar price unavailable right now, so the curve is set in ${q}: opens at 2 ${q}, graduates at ${FALLBACK_TARGET[targetUsd]} ${q}.`}
      </p>
    </section>
  );
  // After the pair, since the dev buy is paid in the chosen stock.
  const devBuySection = (
    <section className="launch-section">
      <h3>Dev buy</h3>
      <div className="launch-devbuy">
        <div className="segmented" role="radiogroup" aria-label="Dev buy in">
          {(
            [
              ["percent", "% of supply"],
              ["amount", `${q} amount`],
            ] as const
          ).map(([key, title]) => (
            <button
              type="button"
              role="radio"
              key={key}
              aria-checked={devBuyMode === key}
              onClick={() => {
                // Carry the current buy across, so switching never changes it.
                if (key === "amount" && devBuyAtoms > 0n) setDevBuyText(String(devBuy));
                if (key === "percent")
                  setDevBuyPercent(devBuyTokens ? Math.min(maxPercent, Math.round(devBuyTokens.percent * 2) / 2) : 0);
                setDevBuyMode(key);
              }}
            >
              {title}
            </button>
          ))}
        </div>
        {devBuyMode === "percent" ? (
          <div className="devbuy-slider">
            <input
              type="range"
              min={0}
              max={maxPercent}
              step={0.5}
              value={Math.min(devBuyPercent, maxPercent)}
              onChange={(e) => setDevBuyPercent(Number(e.target.value))}
              aria-label="Dev buy, % of supply"
            />
            <div>
              <span>0%</span>
              <strong>{Math.min(devBuyPercent, maxPercent)}%</strong>
              <span>{maxPercent}%</span>
            </div>
          </div>
        ) : (
          <Input
            id="dev-buy"
            inputMode="decimal"
            value={devBuyText}
            onChange={(e) => setDevBuyText(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder={maxQuote ? `${q} amount, up to ~${amount(Number(maxQuote) / 1e8)}` : `${q} amount`}
            aria-invalid={!devBuyOk}
          />
        )}
        <p className={devBuyOk ? "sr-note" : "sr-note text-destructive"} role="status">
          {!devBuyOk
            ? devBuyProblem
            : devBuyTokens
              ? devBuyMode === "percent"
                ? `≈ ${amount(devBuy)} ${q} for ${Math.round(devBuyTokens.tokens).toLocaleString()} ${symbol || "tokens"}.`
                : `≈ ${devBuyTokens.percent.toFixed(2)}% of the supply (${Math.round(devBuyTokens.tokens).toLocaleString()} ${symbol || "tokens"}).`
              : `Optional. Buy up to ${maxPercent}% of the supply as the pool's very first trade, in the same transaction as the launch, so nothing trades before you. Paid in ${q}.`}
        </p>
        {devBuyOk && devBuyTokens && (
          <p className="sr-note">Meteora and Jupiter show it as dev holdings on the token&apos;s page.</p>
        )}
      </div>
    </section>
  );
  const curveSection = (
    <section className="launch-section">
      <h3>The curve</h3>
      <p className="sr-note">
        Every token opens at a {compactUsd(OPEN_USD)} market cap. Choose where it graduates to a permanent Meteora pool,
        and the trading fee.
      </p>
      <fieldset>
        <legend>Curve shape</legend>
        <div className="curve-presets shape-presets">
          {SHAPES.map(([key, title]) => (
            <button
              type="button"
              key={key}
              aria-pressed={(settings.shape ?? "classic") === key}
              onClick={() => setSettings((s) => ({ ...s, shape: key === "classic" ? undefined : key }))}
            >
              <strong>{title}</strong>
            </button>
          ))}
        </div>
        <p className="sr-note">{SHAPES.find(([key]) => key === (settings.shape ?? "classic"))![2]}</p>
      </fieldset>
      <fieldset>
        <legend>Graduates at</legend>
        <div className="curve-presets">
          {GRADUATION_USD.map((usd) => (
            <button type="button" key={usd} aria-pressed={targetUsd === usd} onClick={() => setTargetUsd(usd)}>
              <strong>{compactUsd(usd)}</strong>
              <span>{GRADUATION_NOTE[usd]}</span>
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
        <div className="curve-stats">
          <div>
            <strong>{raiseText}</strong>
            <span>raised at graduation</span>
          </div>
          <div>
            <strong>{soldPercent === null ? "—" : `${Math.round(soldPercent)}%`}</strong>
            <span>of the supply sold on the curve</span>
          </div>
          {[100, 1_000].map((usd) => {
            const p = buysPercent(usd);
            return (
              <div key={usd}>
                <strong>{p === null ? "—" : `${p.toFixed(1)}%`}</strong>
                <span>of the supply for {compactUsd(usd)}</span>
              </div>
            );
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend>Trading fee</legend>
        <div className="curve-presets">
          {FEES.map(([fee, note]) => (
            <button
              type="button"
              key={fee}
              aria-pressed={settings.fee === fee}
              onClick={() => setSettings((s) => ({ ...s, fee }))}
            >
              <strong>{fee / 100}%</strong>
              <span>{note}</span>
            </button>
          ))}
        </div>
        <p className="sr-note">
          On every buy and sell: 40% to your fee model, 40% to Sonata, 20% to Meteora (on trades made here, a fifth of that comes back to Sonata as referrer; your 40% never changes). No transfer tax. After
          graduation: a 1% pool fee, a little more on fast moves (Meteora&apos;s own volatility fee, on every graduated
          pool), and half the locked pool is yours
          {PAYOUT_BOT_V2 ? "; the fees from Sonata's half are split like the fees above" : ""}.
        </p>
      </fieldset>
      <fieldset>
        <legend>Extras</legend>
        <div className="launch-extras">
          {(
            [
              [
                "volatility",
                "Volatility fee",
                "On the curve: when the price moves fast, the fee rises by up to 20%, split like the rest of the fee. After graduation, Meteora's pool adds its own volatility fee either way.",
              ],
              [
                "airdrop",
                "Graduation airdrop",
                `${AIRDROP_PERCENT}% of the supply is kept off the curve and airdropped to holders, pro rata, the moment the token graduates. Your own wallet is left out.`,
              ],
            ] as const
          )
            // The airdrop is sent by the new payout bot.
            .filter(([key]) => key !== "airdrop" || PAYOUT_BOT_V2)
            .map(([key, title, line]) => (
              <button
                type="button"
                role="switch"
                key={key}
                aria-checked={!!settings[key]}
                onClick={() => setSettings((s) => ({ ...s, [key]: !s[key] }))}
              >
                <span className="launch-switch" aria-hidden />
                <div>
                  <strong>{title}</strong>
                  <span>{line}</span>
                </div>
              </button>
            ))}
        </div>
      </fieldset>
    </section>
  );
  const feeSection = (
    <section className="launch-section">
      <h3>Fee model</h3>
      <p className="sr-note">Where your {share} of every trade goes. Set once, runs forever.</p>
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
            {/* Holder rewards come out of the trading fee, so the fee itself never changes here. */}
            {(["standard", "reward"] as const).map((key) => (
              <button type="button" role="radio" key={key} aria-checked={model === key} onClick={() => setModel(key)}>
                {key === "reward" ? share : "None"}
              </button>
            ))}
          </div>
          <p className="sr-note">
            {model === "reward"
              ? "Paid to holders out of the trading fee. No transfer tax."
              : "A standard token has no holder rewards. Pick a rate to launch a reward token instead."}
          </p>
        </>
      )}
      {model === "standard" && PAYOUT_BOT_V2 && (
        <>
          <Label>Send your {share} to</Label>
          <div className="launch-options module-options" role="radiogroup" aria-label="Send your share to">
            {DESTINATIONS.map(({ key, title, line, icon: Icon }) => (
              <button
                type="button"
                role="radio"
                key={key}
                aria-checked={destination === key}
                onClick={() => pickDestination(key)}
              >
                <Icon size={18} />
                <strong>{title}</strong>
                <span>{line}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {feeModule === "split" && (
        <div className="split-rows">
          <Label>Wallets (shares add up to 100%)</Label>
          {split.map((r, i) => (
            <div className="split-row" key={i}>
              <Input
                value={r.wallet}
                onChange={(e) =>
                  setSplit((rows) => rows.map((x, j) => (j === i ? { ...x, wallet: e.target.value } : x)))
                }
                placeholder="Solana wallet address"
                aria-label={`Wallet ${i + 1}`}
                aria-invalid={!!r.wallet && !splitRows[i].walletOk}
              />
              <Input
                inputMode="numeric"
                value={r.weight}
                onChange={(e) =>
                  setSplit((rows) =>
                    rows.map((x, j) => (j === i ? { ...x, weight: e.target.value.replace(/[^0-9]/g, "") } : x)),
                  )
                }
                aria-label={`Share ${i + 1}`}
                aria-invalid={!splitRows[i].weightOk}
              />
              <span className="sr-note">
                {splitTotal && splitRows[i].weightOk ? `${Math.round((splitRows[i].weight / splitTotal) * 100)}%` : "—"}
              </span>
              {split.length > 1 && (
                <button
                  type="button"
                  className="split-remove"
                  aria-label={`Remove wallet ${i + 1}`}
                  onClick={() => setSplit((rows) => rows.filter((_, j) => j !== i))}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
          <div className="split-actions">
            {split.length < MAX_SPLIT && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSplit((rows) => [...rows, { wallet: "", weight: "50" }])}
              >
                Add wallet
              </Button>
            )}
            {address && !split.some((r) => r.wallet.trim() === address) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSplit((rows) =>
                    rows[0] && !rows[0].wallet.trim()
                      ? rows.map((x, j) => (j === 0 ? { ...x, wallet: address } : x))
                      : rows.length < MAX_SPLIT
                        ? [...rows, { wallet: address, weight: "50" }]
                        : rows,
                  )
                }
              >
                Add my wallet
              </Button>
            )}
          </div>
          <p className={splitOk ? "sr-note" : "sr-note text-destructive"}>
            {splitOk
              ? "Fixed at launch. Shares are whole numbers from 1 to 100."
              : "Use normal Solana wallets, each once, with a share from 1 to 100."}
          </p>
        </div>
      )}
      {!feeModule && model !== "reward" && (
        <div>
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
        </div>
      )}
      <p className="launch-info">
        <Info size={16} />
        <span>
          {modelInfo}{" "}
          {model === "reward" || feeModule
            ? "Sonata's payout bot collects the fees and pays out every 15 minutes; small amounts roll over."
            : "Collected and paid automatically every 15 minutes."}
        </span>
      </p>
    </section>
  );
  const reviewSection = (
    <section className="launch-section launch-review">
      <h3>Review &amp; launch</h3>
      <p className="sr-note">
        One approval creates the token, its Meteora pool{devBuyTokens ? " with your dev buy" : ""} and its Sonata
        treasury. Your wallet is the creator; Sonata collects the fees.
      </p>
      <div className="launch-receipt">
        {(
          [
            ["Token", name.trim() ? `${name.trim()} ($${symbol || "—"})` : "—"],
            ["Pair", q],
            [
              "Curve",
              [
                `${curveText} · ${pct(settings.fee)} fee`,
                SHAPES.find(([key]) => key === (settings.shape ?? "classic"))![1],
                ...(settings.volatility ? ["volatility fee"] : []),
                ...(settings.airdrop ? [`${AIRDROP_PERCENT}% graduation airdrop`] : []),
              ].join(" · "),
            ],
            ["Fee model", modelName],
            ["Dev buy", devBuyTokens ? `${amount(devBuy)} ${q} · ≈ ${devBuyTokens.percent.toFixed(2)}%` : "None"],
          ] as [string, string][]
        ).map(([label, value]) => (
          <div className="sr-detail-row" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <p className="sr-note">
        Network cost {LAUNCH_COST_SOL} for account rent. No platform launch fee.
        {devBuyTokens ? ` Plus ${amount(devBuy)} ${q} for your dev buy.` : ""}
      </p>
      {problems.length > 0 && (
        <div className="launch-problems" role="alert">
          {problems.map(([text, at]) => (
            <button type="button" key={text} onClick={() => go(at)}>
              {text} <span>Go to step {at + 1} →</span>
            </button>
          ))}
        </div>
      )}
      {curveError && (
        <p className="sr-note text-destructive" role="alert">
          {curveError}
        </p>
      )}
      <p className="sr-note">
        Fees depend on trading that may never happen. A token can lose all of its value. Test tokens on Solana Devnet
        have no value.
      </p>
    </section>
  );

  const summary = (
    <Card className="sr-panel launch-summary">
      <span className="sr-eyebrow">YOUR LAUNCH</span>
      <div className="launch-summary-head">
        {profile.preview && <img className="token-image" src={profile.preview} alt="" width={40} height={40} />}
        <div>
          <h3>
            <TokenPair base={symbol || "TOKEN"} quote={q} />
          </h3>
          <p className="sr-note">{name.trim() || "Your token name"}</p>
        </div>
      </div>
      <div className="launch-receipt">
        {(
          [
            ["Fee model", modelName],
            ["Pair", q],
            ["Opens at", `${settings.pricing ? compactUsd(OPEN_USD) : `2 ${q}`} market cap`],
            [
              "Graduates at",
              `${settings.pricing ? compactUsd(settings.pricing.targetUsd) : `${settings.target} ${q}`}${raiseText !== "—" ? ` · ${raiseText} raised` : ""}`,
            ],
            ["Curve", SHAPES.find(([key]) => key === (settings.shape ?? "classic"))![1]],
            ["Supply", "1 billion · fixed"],
            [
              "Trading fee",
              `${pct(settings.fee)}${settings.volatility ? ` (up to ${pct(settings.fee * 1.2)} on fast moves)` : ""} · no transfer tax`,
            ],
            ...shareRows,
            ["Fee → Sonata", share],
            ["Fee → Meteora", half],
            ["Cadence", cadence],
            ...(settings.airdrop ? [["Graduation airdrop", `${AIRDROP_PERCENT}% of supply to holders`]] : []),
            [
              "After graduation",
              `1% pool fee, more on fast moves · half the locked pool is yours${PAYOUT_BOT_V2 ? " · fee model keeps running" : ""}`,
            ],
            ...(devBuyTokens ? [["Dev buy", `${amount(devBuy)} ${q} · ≈ ${devBuyTokens.percent.toFixed(2)}%`]] : []),
            ["Launch cost", `${LAUNCH_COST_SOL} · rent only`],
          ] as [string, string][]
        ).map(([label, value]) => (
          <div className="sr-detail-row" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      {!feeModule && model !== "reward" && payTo && <p className="sr-note">Pays to {short(payTo)}</p>}
    </Card>
  );

  const controls = (
    <div className="launch-controls">
      {step > 0 && (
        <Button variant="outline" onClick={() => go(step - 1)}>
          Back
        </Button>
      )}
      {step < 4 ? (
        <Button onClick={() => go(step + 1)}>Continue →</Button>
      ) : !address ? (
        <WalletConnectButton />
      ) : (
        <Button disabled={!!blocked || !enabled} onClick={launch}>
          Launch {symbol || "token"}
        </Button>
      )}
    </div>
  );

  return (
    <>
      <div className="sr-heading">
        <div>
          <span className="sr-eyebrow">SONATA</span>
          <h1>Launch your token</h1>
          <p>Launch a token paired with a stock. No platform launch fee.</p>
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
        <>
          <div className="launch-mode">
            <div className="segmented" role="radiogroup" aria-label="Launch mode">
              {(
                [
                  [true, "Quick launch"],
                  [false, "Advanced"],
                ] as const
              ).map(([key, title]) => (
                <button
                  type="button"
                  role="radio"
                  key={title}
                  aria-checked={quick === key}
                  onClick={() => switchMode(key)}
                >
                  {title}
                </button>
              ))}
            </div>
            <p className="sr-note">
              {quick
                ? "The default bonding curve. Name, ticker, go."
                : "Choose the curve, the trading fee and where your share goes."}
            </p>
          </div>
          {quick ? (
            <div className="launch-workspace launch-one-page">
              <Card className="sr-panel launch-form">
                {tokenSection}
                {pairSection}
                {devBuySection}
                <p className="launch-info">
                  <Info size={16} />
                  <span>
                    Opens at a {settings.pricing ? compactUsd(OPEN_USD) : `2 ${q}`} market cap and graduates at{" "}
                    {settings.pricing ? compactUsd(DEFAULT_TARGET_USD) : `${FALLBACK_TARGET[DEFAULT_TARGET_USD]} ${q}`}{" "}
                    into a Meteora pool, with the liquidity locked forever and a 1% pool fee, a little more on fast
                    moves. {pct(initialSettings.fee)} fee on every
                    trade: {pct(initialSettings.fee * 0.4)} to you, paid every 15 minutes in {q}. For holder rewards, a
                    buyback or another curve, use Advanced.
                  </span>
                </p>
                <div className="launch-controls">
                  {!address ? (
                    <WalletConnectButton />
                  ) : (
                    <Button disabled={!!blocked || !enabled} onClick={launch}>
                      Launch {symbol || "token"}
                    </Button>
                  )}
                </div>
                <p className="sr-note">
                  {blocked ||
                    `One approval${devBuyTokens ? `, plus ${amount(devBuy)} ${q} for your dev buy` : ""}. Test tokens on Solana Devnet have no value.`}
                </p>
              </Card>
              {summary}
            </div>
          ) : (
            <div className="launch-workspace launch-stepper">
              <nav className="launch-steps" aria-label="Launch steps" ref={stepsRef}>
                {STEPS.map(([label, hint], i) => (
                  <button
                    type="button"
                    key={label}
                    aria-current={step === i ? "step" : undefined}
                    onClick={() => go(i)}
                  >
                    <span>{i + 1}</span>
                    <div>
                      <strong>{label}</strong>
                      <small>{hint}</small>
                    </div>
                  </button>
                ))}
              </nav>

              <Card className="sr-panel launch-form">
                {step === 0 && tokenSection}
                {step === 1 && (
                  <>
                    {pairSection}
                    {devBuySection}
                  </>
                )}
                {step === 2 && curveSection}
                {step === 3 && feeSection}
                {step === 4 && reviewSection}
                {controls}
                {step === 4 && blocked && !problems.length && <p className="sr-note">{blocked}</p>}
                <p className="sr-note mt-3">
                  <MeteoraLabel>Powered by Meteora</MeteoraLabel>
                </p>
              </Card>

              {summary}
            </div>
          )}
        </>
      )}
    </>
  );
}
