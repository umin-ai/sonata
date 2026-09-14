"use client";
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Buffer } from "buffer/";
import bs58 from "bs58";
import { Keypair, Transaction } from "@solana/web3.js";
import type { SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import {
  ArrowRight,
  Check,
  ExternalLink,
  FlaskConical,
  Layers3,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWallet } from "@/hooks/use-wallet";
import type {
  demoSnapshot,
  prepareDemo,
  DemoActionInput,
} from "@/lib/stockroom/runtime";
import { getMarket, marketCatalog } from "@/lib/stockroom/markets";
import { TokenLogo } from "./devnet/token-logo";
import {
  MarketOverview,
  MarketAssetFlow,
  MarketLedger,
} from "./devnet/market-overview";
import type { demoMarkets } from "@/lib/stockroom/runtime";

type Snapshot = Awaited<ReturnType<typeof demoSnapshot>>;
type Review = Awaited<ReturnType<typeof prepareDemo>>;
type Receipt = {
  marketId?: string;
  signature: string;
  kind: DemoActionInput["kind"];
  status: string;
  at: string;
  wallet: string;
  lastValidBlockHeight: number;
};
const labels = {
  faucet: "Get demo assets",
  open: "Deposit & borrow",
  deposit: "Add collateral",
  borrow: "Borrow demo USD",
  repay: "Repay entire loan",
  withdraw: "Release all collateral",
  supply: "Supply demo USD",
  redeem: "Redeem all supply",
};
const short = (s: string) => s.slice(0, 5) + "…" + s.slice(-5);
const num = (n: number | undefined, d = 2) =>
  n === undefined
    ? "—"
    : n.toLocaleString("en-US", {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      });
const explorer = (kind: "tx" | "address", s: string) =>
  `https://explorer.solana.com/${kind}/${s}?cluster=devnet`;
const runtime = () => import("@/lib/stockroom/runtime");
function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{sub}</small>
    </div>
  );
}

function useStockroomController() {
  const external = useWallet("solana:devnet");
  const pathname = usePathname();
  const router = useRouter();
  const [selectedMarket, setSelectedMarket] = useState("MockSPYx");
  const routeMarket = pathname.match(/^\/(?:markets|activity)\/([^/]+)$/)?.[1];
  const marketId =
    routeMarket &&
    (routeMarket === "legacy" ||
      marketCatalog.some((m) => m.id === routeMarket))
      ? routeMarket
      : selectedMarket;
  useEffect(() => {
    // Remember the market when moving from its route to Portfolio or Activity.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Synchronize the remembered selection with the router.
    if (routeMarket) setSelectedMarket(marketId);
  }, [routeMarket, marketId]);
  const deployment = getMarket(marketId);
  const [markets, setMarkets] = useState<
    Awaited<ReturnType<typeof demoMarkets>>
  >([]);
  const [marketError, setMarketError] = useState("");
  const currentMarket = useRef(marketId);
  const demo = useRef<Keypair | null>(null),
    lock = useRef(false);
  const [demoAddress, setDemoAddress] = useState(""),
    [picker, setPicker] = useState(false);
  const address = demoAddress || external.account?.address || "";
  const [data, setData] = useState<Snapshot | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(""),
    [review, setReview] = useState<Review | null>(null),
    [records, setRecords] = useState<Receipt[]>([]),
    [ready, setReady] = useState(false);
  const [collateral, setCollateral] = useState("8"),
    [cash, setCash] = useState("500"),
    [supply, setSupply] = useState("100");
  const currentAddress = useRef(address);
  const activeRecords = records.filter(
      (r) => r.wallet === address && (r.marketId ?? "legacy") === marketId,
    ),
    pending = activeRecords.some((r) => r.status === "pending");
  const disabled = !!busy || loading || pending;
  const refresh = useCallback(async () => {
    const target = address,
      selected = marketId;
    setLoading(true);
    try {
      const next = await (
        await runtime()
      ).demoSnapshot(target || undefined, selected);
      if (
        currentAddress.current === target &&
        currentMarket.current === selected
      ) {
        setData(next);
        setError("");
      }
      try {
        const overview = await (await runtime()).demoMarkets();
        setMarkets(overview);
        setMarketError("");
      } catch (e) {
        setMarketError(
          e instanceof Error ? e.message : "Market list unavailable.",
        );
      }
    } catch (e) {
      console.error("Devnet read failed", e);
      if (
        currentAddress.current === target &&
        currentMarket.current === selected
      )
        setError(e instanceof Error ? e.message : "Unable to read Devnet.");
    } finally {
      if (
        currentAddress.current === target &&
        currentMarket.current === selected
      )
        setLoading(false);
    }
  }, [address, marketId]);
  // Synchronize the selected wallet with its external RPC state after hydration.
  /* eslint-disable react-hooks/set-state-in-effect -- Hydrate browser-only wallet storage and synchronize external RPC state. */
  useEffect(() => {
    currentAddress.current = address;
    currentMarket.current = marketId;
    setData(null);
    setReview(null);
    void refresh();
  }, [address, marketId, refresh]);
  // Browser storage is unavailable during server rendering.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("stockroom.devnet.wallet.v1");
      if (saved) {
        const k = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved)));
        demo.current = k;
        setDemoAddress(k.publicKey.toBase58());
      }
      const receipts = JSON.parse(
        localStorage.getItem("stockroom.devnet.receipts.v1") || "[]",
      );
      if (Array.isArray(receipts))
        setRecords(
          receipts
            .filter(
              (r) =>
                r &&
                typeof r.signature === "string" &&
                typeof r.wallet === "string",
            )
            .slice(0, 40),
        );
    } catch {
      setNotice(
        "Browser storage is unavailable. Keep this tab open to retain your demo wallet.",
      );
    }
    setReady(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(
        "stockroom.devnet.receipts.v1",
        JSON.stringify(records),
      );
    } catch {}
  }, [records, ready]);
  function selectMarket(
    id: string,
    destination: "markets" | "activity" = "markets",
  ) {
    if (disabled || lock.current || review) return;
    getMarket(id);
    currentMarket.current = id;
    setSelectedMarket(id);
    if (id !== marketId) setData(null);
    setReview(null);
    setNotice("");
    setError("");
    router.push(`/${destination}/${encodeURIComponent(id)}`);
  }
  async function startDemo() {
    if (disabled) return;
    setError("");
    await external.disconnect();
    if (!demo.current) demo.current = Keypair.generate();
    try {
      sessionStorage.setItem(
        "stockroom.devnet.wallet.v1",
        JSON.stringify([...demo.current.secretKey]),
      );
    } catch {
      setNotice(
        "Keep this tab open; your temporary wallet cannot be saved in this browser.",
      );
    }
    setDemoAddress(demo.current.publicKey.toBase58());
    setPicker(false);
  }
  function connectExternal() {
    setDemoAddress("");
    try {
      sessionStorage.removeItem("stockroom.devnet.wallet.v1");
    } catch {}
    setPicker(true);
  }
  async function prepare(kind: DemoActionInput["kind"]) {
    if (lock.current || pending) return;
    if (!address) {
      setPicker(true);
      return;
    }
    lock.current = true;
    setBusy("Checking the transaction…");
    setError("");
    setNotice("");
    try {
      const r = await (
        await runtime()
      ).prepareDemo({
        wallet: address,
        marketId,
        kind,
        amount: kind === "supply" ? supply : cash,
        collateral,
      });
      if (
        r.network !== "solana:devnet" ||
        r.wallet !== currentAddress.current ||
        r.marketId !== currentMarket.current
      )
        throw Error("Wallet or network changed. Review again.");
      setReview(r);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not prepare the action.",
      );
    } finally {
      setBusy("");
      lock.current = false;
    }
  }
  async function checkReceipt(record: Receipt) {
    const receipt = await (
      await runtime()
    ).demoReceipt(record.signature, record.lastValidBlockHeight);
    if (
      ["confirmed", "finalized", "failed", "expired"].includes(receipt.status)
    ) {
      setRecords((old) =>
        old.map((r) =>
          r.signature === record.signature
            ? { ...r, status: receipt.status }
            : r,
        ),
      );
      if (receipt.status === "failed" || receipt.status === "expired") {
        setError(
          receipt.status === "expired"
            ? "The transaction expired before confirmation. Refresh and review again."
            : "The transaction failed on Devnet. Refresh your balances before trying again.",
        );
      } else setNotice(labels[record.kind] + " confirmed on Solana Devnet.");
      await refresh();
      return true;
    }
    return false;
  }
  async function confirm() {
    if (!review || lock.current) return;
    lock.current = true;
    setBusy("Waiting for your signature…");
    setError("");
    let submitted: Receipt | null = null;
    try {
      if (
        review.wallet !== address ||
        review.marketId !== currentMarket.current ||
        Date.now() > review.expiresAt
      )
        throw Error(
          "This preview expired or the wallet changed. Close it and review again.",
        );
      const tx = Transaction.from(Buffer.from(review.transaction, "base64")),
        message = tx.serializeMessage();
      let signed: Transaction;
      if (demoAddress && demo.current) {
        tx.partialSign(demo.current);
        signed = tx;
      } else {
        const f = external.wallet?.features as
          Partial<SolanaSignTransactionFeature> | undefined;
        if (!f?.["solana:signTransaction"] || !external.account)
          throw Error(
            "This wallet must support signing Solana Devnet transactions.",
          );
        const [result] = await f["solana:signTransaction"].signTransaction({
          account: external.account,
          chain: "solana:devnet",
          transaction: Uint8Array.from(
            Buffer.from(review.transaction, "base64"),
          ),
        });
        signed = Transaction.from(result.signedTransaction);
      }
      if (
        !signed.serializeMessage().equals(message) ||
        !signed.verifySignatures()
      )
        throw Error(
          "Signed transaction differs from the reviewed action. Nothing was sent.",
        );
      const signature = bs58.encode(signed.signature!);
      submitted = {
        signature,
        kind: review.kind,
        marketId: review.marketId,
        status: "pending",
        at: new Date().toISOString(),
        wallet: address,
        lastValidBlockHeight: review.lastValidBlockHeight,
      };
      setRecords((old) =>
        [submitted!, ...old.filter((r) => r.signature !== signature)].slice(
          0,
          40,
        ),
      );
      // Preserve the receipt before the network call, including an ambiguous response.
      try {
        localStorage.setItem(
          "stockroom.devnet.receipts.v1",
          JSON.stringify([submitted, ...records].slice(0, 40)),
        );
      } catch {}
      setBusy("Sending to Solana Devnet…");
      await (await runtime()).submitDemo(signed.serialize().toString("base64"));
      setReview(null);
      setBusy("Waiting for network confirmation…");
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await checkReceipt(submitted)) return;
      }
      setNotice(
        "Still waiting for confirmation. Use Check receipt below before trying another action.",
      );
    } catch (e) {
      setReview(null);
      setError(
        (e instanceof Error ? e.message : "The action was interrupted.") +
          (submitted
            ? " Your receipt is saved below; check its status before retrying."
            : ""),
      );
    } finally {
      setBusy("");
      lock.current = false;
    }
  }
  const p = data?.position,
    w = data?.wallet,
    hasLoan = !!p?.hasDebt;
  const projectedCollateral = (p?.collateral || 0) + Number(collateral || 0),
    projectedDebt = (p?.debt || 0) + Number(cash || 0);
  const projectedLtv =
    projectedCollateral > 0
      ? projectedDebt / (projectedCollateral * deployment.demoPrice)
      : 0;
  const badBorrow =
    !Number.isFinite(projectedLtv) ||
    Number(collateral) <= 0 ||
    Number(cash) <= 0 ||
    projectedLtv > 0.5 ||
    (w !== null && w !== undefined && Number(collateral) > w.stock);
  const ltv =
    p && p.collateral > 0 ? p.debt / (p.collateral * deployment.demoPrice) : 0;

  return {
    external,
    pathname,
    marketId,
    deployment,
    markets,
    marketError,
    address,
    demoAddress,
    picker,
    setPicker,
    data,
    loading,
    error,
    notice,
    busy,
    setBusy,
    setError,
    review,
    setReview,
    records,
    activeRecords,
    pending,
    disabled,
    refresh,
    selectMarket,
    startDemo,
    connectExternal,
    prepare,
    checkReceipt,
    confirm,
    collateral,
    setCollateral,
    cash,
    setCash,
    supply,
    setSupply,
    p,
    w,
    hasLoan,
    projectedLtv,
    badBorrow,
    ltv,
  };
}

const StockroomContext = createContext<ReturnType<
  typeof useStockroomController
> | null>(null);
function useStockroom() {
  const value = useContext(StockroomContext);
  if (!value) throw new Error("Stockroom workspace is unavailable.");
  return value;
}
export function StockroomProvider({ children }: { children: React.ReactNode }) {
  const controller = useStockroomController();
  return (
    <StockroomContext.Provider value={controller}>
      <StockroomShell>{children}</StockroomShell>
    </StockroomContext.Provider>
  );
}

function WalletPanel() {
  const {
    deployment,
    address,
    demoAddress,
    setPicker,
    data,
    disabled,
    startDemo,
    prepare,
    p,
    w,
  } = useStockroom();
  return (
    <>
      <section className="card devnet-start">
        <div className="section-title">
          <div>
            <p className="eyebrow">START HERE</p>
            <h2>
              {address ? "Your Devnet wallet" : "Try a complete lending cycle"}
            </h2>
          </div>
          <span className="provider">
            {demoAddress
              ? "Temporary demo wallet"
              : address
                ? "Connected wallet"
                : "No extension needed"}
          </span>
        </div>
        {!address ? (
          <>
            <p className="devnet-copy">
              Create a temporary wallet in this tab. Claim test assets and make
              your first loan in a few clicks.
            </p>
            <div className="devnet-buttons">
              <Button onClick={() => void startDemo()} disabled={disabled}>
                Try with demo wallet <ArrowRight size={15} />
              </Button>
              <Button
                variant="outline"
                onClick={() => setPicker(true)}
                disabled={disabled}
              >
                Use my own wallet
              </Button>
            </div>
            <p className="fine-print">
              This wallet is saved only for this browser session. Use it
              exclusively for this Devnet demo.
            </p>
          </>
        ) : (
          <>
            <div className="devnet-wallet-grid">
              <Stat
                label={deployment.symbol}
                value={num(w?.stock, 4)}
                sub="Wallet balance · Token-2022"
              />
              <Stat
                label="Demo USD"
                value={num(w?.cash)}
                sub="Wallet balance · SPL token"
              />
              <Stat
                label="Devnet SOL"
                value={num(w?.sol, 5)}
                sub="For account rent and network fees"
              />
            </div>
            <div className="devnet-wallet-footer">
              <a
                href={explorer("address", address)}
                target="_blank"
                rel="noreferrer"
              >
                {short(address)} <ExternalLink size={12} />
              </a>
              {p?.exists ? (
                <span>
                  <Check size={13} />
                  Starter assets claimed
                </span>
              ) : (
                <Button
                  disabled={disabled || !data}
                  onClick={() => void prepare("faucet")}
                >
                  Get demo assets <ArrowRight size={14} />
                </Button>
              )}
            </div>
            {!p?.exists && (
              <p className="fine-print">
                One pack per wallet per market: 25 {deployment.symbol}, 1,000
                demo USD and 0.005 Devnet SOL. Account setup uses part of that
                SOL.
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}

function PositionPanel() {
  const { deployment, disabled, prepare, p, hasLoan, ltv } = useStockroom();
  return (
    <>
      <section className="outlook-card devnet-position">
        <div className="section-title">
          <div>
            <p className="eyebrow">YOUR POSITION</p>
            <h2>{hasLoan ? "A loan you can manage" : "Ready when you are"}</h2>
          </div>
          <ShieldCheck size={22} />
        </div>
        <div className="devnet-position-metrics">
          <Stat
            label="Collateral deposited"
            value={num(p?.collateral, 4)}
            sub={deployment.symbol}
          />
          <Stat
            label="Outstanding debt"
            value={num(p?.debt, 6)}
            sub="demo USD · includes accrued interest"
          />
          <Stat
            label="Supplied liquidity"
            value={num(p?.supplied, 6)}
            sub="demo USD · estimated redemption value"
          />
        </div>
        <div className="devnet-health">
          <div>
            <span>Current loan-to-value</span>
            <strong>{num(ltv * 100, 1)}%</strong>
          </div>
          <div className="health-track">
            <span style={{ width: Math.min(ltv * 100, 100) + "%" }} />
            <i style={{ left: "65%" }} />
          </div>
          <div className="devnet-health-labels">
            <span>0%</span>
            <span>Liquidation starts at 65%</span>
          </div>
        </div>
        <div className="devnet-buttons">
          <Button
            variant="outline"
            disabled={disabled || !hasLoan}
            onClick={() => void prepare("repay")}
          >
            Repay entire loan
          </Button>
          <Button
            variant="outline"
            disabled={disabled || hasLoan || !p?.collateral}
            onClick={() => void prepare("withdraw")}
          >
            Release collateral
          </Button>
          {p?.hasSupply && (
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => void prepare("redeem")}
            >
              Redeem supply
            </Button>
          )}
        </div>
        <p className="fine-print">
          Repayment closes your debt, including interest. You can then release
          all collateral in a separate transaction.
        </p>
      </section>
    </>
  );
}

function ReceiptsPanel() {
  const { busy, setBusy, setError, activeRecords, checkReceipt } =
    useStockroom();
  return (
    <>
      <section className="card devnet-activity">
        <div className="section-title">
          <h2>Your transaction receipts</h2>
          <span className="provider">Solana Devnet</span>
        </div>
        {!activeRecords.length ? (
          <p className="devnet-copy">
            Transactions signed in this browser for this wallet and market
            appear here. The market activity below includes other wallets.
          </p>
        ) : (
          <div>
            {activeRecords.map((r) => (
              <div className="devnet-receipt" key={r.signature}>
                <div>
                  <strong>{labels[r.kind]}</strong>
                  <a
                    href={explorer("tx", r.signature)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {short(r.signature)} <ExternalLink size={12} />
                  </a>
                </div>
                <div>
                  <span className={"devnet-status " + r.status}>
                    {r.status}
                  </span>
                  {r.status === "pending" && (
                    <Button
                      variant="ghost"
                      disabled={!!busy}
                      onClick={() => {
                        setBusy("Checking receipt…");
                        void checkReceipt(r)
                          .catch((e) => setError(e.message))
                          .finally(() => setBusy(""));
                      }}
                    >
                      Check receipt
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function LendingPanel() {
  const {
    deployment,
    address,
    data,
    busy,
    disabled,
    prepare,
    collateral,
    setCollateral,
    cash,
    setCash,
    supply,
    setSupply,
    p,
    w,
    projectedLtv,
    badBorrow,
  } = useStockroom();
  return (
    <>
      <section className="card devnet-action">
        <Tabs defaultValue="borrow">
          <TabsList className="mode-tabs devnet-action-tabs">
            <TabsTrigger value="borrow">Borrow</TabsTrigger>
            <TabsTrigger value="supply">Supply</TabsTrigger>
          </TabsList>
          <TabsContent value="borrow">
            <h2>Stocks in. Cash out.</h2>
            <p className="devnet-copy">
              Deposit collateral and receive your loan in one transaction.
            </p>
            <label className="field-label" htmlFor="demo-collateral">
              Deposit {deployment.symbol}
              <span>Available: {num(w?.stock, 4)}</span>
            </label>
            <div className="amount-input">
              <Input
                id="demo-collateral"
                inputMode="decimal"
                value={collateral}
                onChange={(e) => setCollateral(e.target.value)}
                disabled={!!busy}
              />
              <span className="mock-token-label">
                <TokenLogo symbol={deployment.symbol} size={24} />
                {deployment.symbol}
              </span>
            </div>
            <label className="field-label" htmlFor="demo-cash">
              Borrow demo USD<span>50% maximum LTV</span>
            </label>
            <div className="amount-input">
              <Input
                id="demo-cash"
                inputMode="decimal"
                value={cash}
                onChange={(e) => setCash(e.target.value)}
                disabled={!!busy}
              />
              <span>USD</span>
            </div>
            <div className="cash-presets">
              {["100", "500", "750"].map((n) => (
                <Button
                  key={n}
                  variant="outline"
                  aria-pressed={cash === n}
                  disabled={!!busy}
                  onClick={() => setCash(n)}
                >
                  {n}
                </Button>
              ))}
            </div>
            <dl className="devnet-terms">
              <Detail label="Illustrative stock price">
                {num(deployment.demoPrice)} demo USD
              </Detail>
              <Detail label="Loan-to-value after borrowing">
                {num(projectedLtv * 100, 1)}%
              </Detail>
              <Detail label="Borrow APR">5.00%</Detail>
              <Detail label="Origination fee">0 demo USD</Detail>
            </dl>
            {badBorrow && (
              <p className="input-error">
                Choose available collateral and a loan within 50% of its value.
              </p>
            )}
            <Button
              className="primary-action"
              disabled={disabled || badBorrow || !p?.exists || !!data?.paused}
              onClick={() => void prepare("open")}
            >
              Review deposit & borrow <ArrowRight size={15} />
            </Button>
            <p className="action-caption">
              {!address
                ? "Create or connect a wallet to begin."
                : !p?.exists
                  ? "Get demo assets first."
                  : "Preview the exact transaction before signing."}
            </p>
          </TabsContent>
          <TabsContent value="supply">
            <h2>Put demo cash to work.</h2>
            <p className="devnet-copy">
              Supply demo USD to the lending pool. Your shares track your claim
              on its assets.
            </p>
            <label className="field-label" htmlFor="demo-supply">
              Supply demo USD<span>Available: {num(w?.cash)}</span>
            </label>
            <div className="amount-input">
              <Input
                id="demo-supply"
                inputMode="decimal"
                value={supply}
                onChange={(e) => setSupply(e.target.value)}
                disabled={!!busy}
              />
              <span>USD</span>
            </div>
            <dl className="devnet-terms">
              <Detail label="Your supplied balance">
                {num(p?.supplied, 6)}
              </Detail>
              <Detail label="Borrower interest rate">5.00% APR</Detail>
              <Detail label="Supplier yield">Varies with utilization</Detail>
              <Detail label="Withdrawal">Subject to available cash</Detail>
            </dl>
            <Button
              className="primary-action"
              disabled={disabled || !p?.exists || !!data?.paused}
              onClick={() => void prepare("supply")}
            >
              Review supply <ArrowRight size={15} />
            </Button>
            <Button
              className="devnet-full"
              variant="outline"
              disabled={disabled || !p?.hasSupply}
              onClick={() => void prepare("redeem")}
            >
              Redeem all supply
            </Button>
            <p className="action-caption">
              LP shares earn borrower interest and can absorb losses.
            </p>
          </TabsContent>
        </Tabs>
      </section>
    </>
  );
}

function ProtocolNotes() {
  const { deployment } = useStockroom();
  return (
    <>
      <section className="devnet-notes">
        <p className="eyebrow">WHAT IS REAL IN THIS DEMO?</p>
        <p>
          Wallet signatures, SPL token transfers, collateral custody, lending
          shares and debt accounting execute on Solana Devnet.
        </p>
        <p>
          The stock price is a fixed, administrator-controlled test feed at{" "}
          {num(deployment.demoPrice)} demo USD. It refreshes with borrowing
          transactions. These tokens do not represent real equities or
          redeemable dollars.
        </p>
        <p>
          The programs are upgradeable and have not been independently audited.
        </p>
        <div className="devnet-proof-links">
          <a
            href={explorer("address", deployment.market)}
            target="_blank"
            rel="noreferrer"
          >
            Market account <ExternalLink size={12} />
          </a>
          <a
            href={explorer("address", deployment.oracleProgram)}
            target="_blank"
            rel="noreferrer"
          >
            Demo oracle <ExternalLink size={12} />
          </a>
        </div>
      </section>
    </>
  );
}

function MarketTerms() {
  const { data } = useStockroom();
  return (
    <>
      <section className="card market-metrics-bar" aria-label="Market terms">
        <Stat
          label="Available to borrow"
          value={num(data?.liquidity)}
          sub="demo USD · funded on Devnet"
        />
        <Stat
          label="Borrow APR"
          value={data ? "5.00%" : "—"}
          sub="Fixed annual rate · interest accrues"
        />
        <Stat
          label="Maximum opening LTV"
          value={data ? "50%" : "—"}
          sub="Borrow up to half your collateral value"
        />
        <Stat
          label="Liquidation LTV"
          value={data ? "65%" : "—"}
          sub="5% liquidator bonus"
        />
      </section>
    </>
  );
}

function StatusBanners() {
  const { external, pathname, error, notice, busy } = useStockroom();
  return (
    <>
      {error && (
        <div className="input-error" role="alert">
          {error}
          {error.includes("Sign in") && (
            <>
              {" "}
              <a
                className="text-link"
                href={`/signin-with-chatgpt?return_to=${encodeURIComponent(pathname)}`}
              >
                Sign in to use the demo
              </a>
            </>
          )}
        </div>
      )}
      {external.error && (
        <div className="input-error" role="alert">
          {external.error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {busy && (
        <div className="devnet-progress" role="status">
          <Loader2 size={16} className="animate-spin" />
          {busy}
        </div>
      )}
    </>
  );
}

function WalletDialogs() {
  const {
    external,
    deployment,
    demoAddress,
    picker,
    setPicker,
    busy,
    review,
    setReview,
    disabled,
    startDemo,
    connectExternal,
    confirm,
  } = useStockroom();
  return (
    <>
      <Dialog open={picker} onOpenChange={setPicker}>
        <DialogContent className="review-dialog">
          <DialogHeader>
            <DialogTitle>Choose your Devnet wallet</DialogTitle>
            <DialogDescription>
              Use the temporary wallet to try this app immediately, or connect a
              wallet with Devnet enabled.
            </DialogDescription>
          </DialogHeader>
          <Button onClick={() => void startDemo()} disabled={disabled}>
            Try with demo wallet <ArrowRight size={15} />
          </Button>
          <p className="review-disclosure">
            The demo key stays in this browser session. Never send real assets
            to it. Closing this session can remove access.
          </p>
          {external.wallets
            .filter((w) => "solana:signTransaction" in w.features)
            .map((wallet) => (
              <Button
                variant="outline"
                key={wallet.name}
                disabled={external.busy || disabled}
                onClick={() => {
                  connectExternal();
                  void external.connect(wallet).then(() => setPicker(false));
                }}
              >
                {wallet.name}
              </Button>
            ))}
          {external.wallets.length === 0 && (
            <p className="fine-print">
              No compatible wallet extension detected. The demo wallet works in
              this browser.
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!review}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(null);
        }}
      >
        <DialogContent className="review-dialog">
          <DialogHeader>
            <p className="eyebrow">REVIEW / SOLANA DEVNET</p>
            <DialogTitle>{review ? labels[review.kind] : ""}</DialogTitle>
            <DialogDescription>
              Simulation passed. Signing sends this action to Stockroom’s Devnet
              contract.
            </DialogDescription>
          </DialogHeader>
          {review && (
            <>
              <dl>
                <Detail label="Market">{deployment.symbol} / demo USD</Detail>
                {Object.entries(review.limits)
                  .filter(([k]) => !k.includes("Shares"))
                  .map(([k, v]) => (
                    <Detail
                      key={k}
                      label={
                        (
                          {
                            stock: `Receive ${deployment.symbol}`,
                            cash:
                              review.kind === "faucet"
                                ? "Receive demo USD"
                                : "Demo USD amount",
                            collateral:
                              review.kind === "withdraw"
                                ? `Release ${deployment.symbol}`
                                : `Deposit ${deployment.symbol}`,
                            testSolGrant: "Devnet SOL starter grant",
                            estimatedCash: "Estimated demo USD",
                            maximumCash: "Maximum demo USD payment",
                            minimumCash: "Minimum demo USD received",
                          } as Record<string, string>
                        )[k] || k
                      }
                    >
                      {typeof v === "number" ? num(v, 6) : v}
                    </Detail>
                  ))}
                <Detail label="Network fee">
                  {num(review.networkFee, 6)} Devnet SOL
                </Detail>
                <Detail label="Network fee payer">
                  {review.kind === "faucet" ? "Demo faucet" : "Your wallet"}
                </Detail>
                <Detail label="Signing wallet">{short(review.wallet)}</Detail>
                <Detail label="Program">
                  {short(deployment.creditProgram)}
                </Detail>
              </dl>
              <p className="review-disclosure">
                {review.kind === "faucet"
                  ? "Starter assets are test tokens. Your grant covers position rent; the faucet covers token account setup and this network fee."
                  : review.kind === "open" || review.kind === "borrow"
                    ? "Your collateral is held by the contract until repaid. Interest accrues at 5% APR. Positions above 65% LTV can be liquidated."
                    : review.kind === "supply"
                      ? "Supplied cash is available to borrowers. Redemption depends on liquidity, and losses can reduce your claim."
                      : "This changes your onchain Devnet position. The tokens have no monetary value."}
              </p>
              <Button
                className="primary-action"
                disabled={!!busy}
                onClick={() => void confirm()}
              >
                {busy ||
                  (demoAddress
                    ? "Sign with demo wallet"
                    : "Sign in wallet")}{" "}
                {!busy && <ArrowRight size={15} />}
              </Button>
              <p className="action-caption">
                {demoAddress
                  ? "This click authorizes your temporary browser wallet to sign."
                  : "Your wallet will ask you to approve the transaction."}
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function StockroomShell({ children }: { children: React.ReactNode }) {
  const { pathname, address, disabled, busy, review, setPicker, data } =
    useStockroom();
  const active = pathname.startsWith("/portfolio")
    ? "/portfolio"
    : pathname.startsWith("/activity")
      ? "/activity"
      : "/";
  return (
    <>
      <header className="topbar">
        <Link
          className="wordmark"
          href="/"
          prefetch={false}
          onClick={(e) => {
            if (busy || review) e.preventDefault();
          }}
        >
          <Layers3 size={25} />
          stockroom<span>/</span>
        </Link>
        <nav className="primary-nav" aria-label="Main navigation">
          {[
            ["/", "Markets"],
            ["/portfolio", "Portfolio"],
            ["/activity", "Activity"],
          ].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              prefetch={false}
              className={active === href ? "devnet-nav-active" : undefined}
              aria-current={active === href ? "page" : undefined}
              aria-disabled={!!busy || !!review}
              onClick={(e) => {
                if (busy || review) e.preventDefault();
              }}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="header-actions">
          <span className="devnet-chip">
            <i />
            Solana Devnet
          </span>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => setPicker(true)}
          >
            <Wallet size={14} />
            {address ? short(address) : "Connect wallet"}
          </Button>
        </div>
      </header>
      <main className="shell devnet-shell">
        <div className="mode-notice devnet-banner">
          <div>
            <FlaskConical size={16} />
            <span>
              <strong>Solana Devnet.</strong> Mock stocks and demo USD have no
              monetary value.
            </span>
          </div>
        </div>
        <StatusBanners />
        {children}
        <footer>
          <span>Stockroom credit · Test assets only</span>
          <span>
            {data
              ? "Read at slot " + data.slot.toLocaleString()
              : "Connecting to Solana Devnet…"}
          </span>
        </footer>
      </main>
      <WalletDialogs />
    </>
  );
}

function PageHeading({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const { refresh, busy, loading } = useStockroom();
  return (
    <div className="workspace-heading">
      <div>
        <p className="eyebrow">STOCKROOM CREDIT</p>
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
      <Button
        variant="outline"
        disabled={!!busy || loading}
        onClick={() => void refresh()}
      >
        <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        Refresh balances
      </Button>
    </div>
  );
}

export function MarketsPage() {
  const { markets, selectMarket, disabled, marketError } = useStockroom();
  return (
    <>
      <PageHeading title="Markets">
        Choose a market to borrow against mock stocks or supply demo USD.
      </PageHeading>
      <MarketOverview
        markets={markets}
        onSelect={selectMarket}
        disabled={disabled}
        error={marketError}
      />
    </>
  );
}

export function MarketPage() {
  const {
    deployment,
    marketId,
    markets,
    selectMarket,
    disabled,
    busy,
    review,
  } = useStockroom();
  return (
    <>
      <div className="market-route-nav">
        <Link href="/" prefetch={false}>
          ← All markets
        </Link>
        <label>
          Market
          <select
            aria-label="Choose market"
            value={marketId}
            disabled={disabled || !!review}
            onChange={(e) => selectMarket(e.target.value)}
          >
            {[...marketCatalog, { id: "legacy", symbol: "Original demo" }].map(
              (m) => (
                <option key={m.id} value={m.id}>
                  {m.symbol}
                </option>
              ),
            )}
          </select>
        </label>
      </div>
      <div className="market-page-heading">
        <TokenLogo symbol={deployment.symbol} />
        <PageHeading title={deployment.symbol}>
          {deployment.name} · fixed test price {num(deployment.demoPrice)} demo
          USD
        </PageHeading>
      </div>
      <MarketTerms />
      <div className="devnet-grid">
        <div className="devnet-main">
          <WalletPanel />
          <PositionPanel />
          <Link
            className="market-activity-link"
            href={`/activity/${marketId}`}
            prefetch={false}
            aria-disabled={!!busy || !!review}
            onClick={(e) => {
              if (busy || review) e.preventDefault();
            }}
          >
            View receipts and market activity <ArrowRight size={15} />
          </Link>
        </div>
        <aside className="devnet-sidebar">
          <LendingPanel />
          <ProtocolNotes />
        </aside>
      </div>
      <MarketAssetFlow markets={markets} marketId={marketId} />
    </>
  );
}

export function ActivityPage() {
  const { marketId, selectMarket, disabled, review, data } = useStockroom();
  return (
    <>
      <PageHeading title="Activity">
        Your transaction receipts and onchain movements for each market.
      </PageHeading>
      <div className="activity-filter">
        <label htmlFor="activity-market">Market</label>
        <select
          id="activity-market"
          value={marketId}
          disabled={disabled || !!review}
          onChange={(e) => selectMarket(e.target.value, "activity")}
        >
          {[...marketCatalog, { id: "legacy", symbol: "Original demo" }].map(
            (m) => (
              <option key={m.id} value={m.id}>
                {m.symbol}
              </option>
            ),
          )}
        </select>
      </div>
      <ReceiptsPanel />
      <MarketLedger
        key={marketId}
        marketId={marketId}
        refreshKey={data?.slot ?? 0}
      />
    </>
  );
}

export function PortfolioPage() {
  const { address, setPicker, data, disabled, selectMarket } = useStockroom();
  const [positions, setPositions] = useState<
    Record<string, { snapshot?: Snapshot; error?: string }>
  >({});
  const [owner, setOwner] = useState("");
  useEffect(() => {
    let cancelled = false;
    if (!address) return;
    setPositions({});
    setOwner(address);
    // Each market can fail independently; never substitute zero balances for a failed read.
    void (async () => {
      const api = await runtime();
      await Promise.allSettled(
        marketCatalog.map(async (m) => {
          try {
            const snapshot = await api.demoSnapshot(address, m.id);
            if (!cancelled)
              setPositions((old) => ({ ...old, [m.id]: { snapshot } }));
          } catch (e) {
            if (!cancelled)
              setPositions((old) => ({
                ...old,
                [m.id]: {
                  error:
                    e instanceof Error
                      ? e.message
                      : "Unable to read this position.",
                },
              }));
          }
        }),
      );
    })().catch((e) => {
      if (!cancelled)
        setPositions(
          Object.fromEntries(
            marketCatalog.map((m) => [
              m.id,
              {
                error:
                  e instanceof Error ? e.message : "Unable to load positions.",
              },
            ]),
          ),
        );
    });
    return () => {
      cancelled = true;
    };
  }, [address, data?.slot]);
  return (
    <>
      <PageHeading title="Portfolio">
        Your collateral, loans and supplied liquidity across Stockroom’s
        markets.
      </PageHeading>
      {!address ? (
        <section className="card portfolio-empty">
          <Wallet size={28} />
          <h2>Connect your Devnet wallet</h2>
          <p>
            Use your wallet or the temporary demo wallet to view your positions.
          </p>
          <Button onClick={() => setPicker(true)}>
            Choose wallet <ArrowRight size={15} />
          </Button>
        </section>
      ) : (
        <section className="card portfolio-table-card">
          <div className="section-title">
            <h2>Your positions</h2>
            <a
              href={explorer("address", address)}
              target="_blank"
              rel="noreferrer"
            >
              {short(address)} <ExternalLink size={13} />
            </a>
          </div>
          <div className="portfolio-rows">
            {marketCatalog.map((m) => {
              const entry = owner === address ? positions[m.id] : undefined;
              const p = entry?.snapshot?.position;
              return (
                <article key={m.id} className="portfolio-row">
                  <div className="portfolio-market">
                    <TokenLogo symbol={m.symbol} />
                    <div>
                      <h3>{m.symbol}</h3>
                      <span>{m.name}</span>
                    </div>
                  </div>
                  {entry?.error ? (
                    <p className="input-error" role="alert">
                      {entry.error}
                    </p>
                  ) : (
                    <dl>
                      <div>
                        <dt>Collateral</dt>
                        <dd>
                          {num(p?.collateral, 4)} <small>{m.symbol}</small>
                        </dd>
                      </div>
                      <div>
                        <dt>Debt</dt>
                        <dd>
                          {num(p?.debt, 6)} <small>demo USD</small>
                        </dd>
                      </div>
                      <div>
                        <dt>Supplied</dt>
                        <dd>
                          {num(p?.supplied, 6)} <small>demo USD</small>
                        </dd>
                      </div>
                    </dl>
                  )}
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() => selectMarket(m.id)}
                  >
                    {entry?.error
                      ? "Open market"
                      : !entry
                        ? "Loading…"
                        : p?.exists
                          ? "Manage position"
                          : "Open market"}
                    <ArrowRight size={14} />
                  </Button>
                </article>
              );
            })}
          </div>
          <p className="market-data-note">
            Balances are read from Solana Devnet. Debt includes accrued
            interest; supplied balances estimate the value of your lending
            shares.
          </p>
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => selectMarket("legacy")}
          >
            Open original demo position <ArrowRight size={14} />
          </Button>
        </section>
      )}
    </>
  );
}
