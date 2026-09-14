"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Buffer } from "buffer/";
import bs58 from "bs58";
import { Keypair, Transaction } from "@solana/web3.js";
import type { SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import {
  ArrowRight,
  ArrowUpRight,
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
import deployment from "@/lib/stockroom/deployment.json";

type Snapshot = Awaited<ReturnType<typeof demoSnapshot>>;
type Review = Awaited<ReturnType<typeof prepareDemo>>;
type Receipt = {
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

export default function DevnetPage() {
  const external = useWallet("solana:devnet");
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
  const activeRecords = records.filter((r) => r.wallet === address),
    pending = activeRecords.some((r) => r.status === "pending");
  const disabled = !!busy || loading || pending;
  const refresh = useCallback(async () => {
    const target = address;
    setLoading(true);
    try {
      const next = await (await runtime()).demoSnapshot(target || undefined);
      if (currentAddress.current === target) {
        setData(next);
        setError("");
      }
    } catch (e) {
      console.error("Devnet read failed", e);
      if (currentAddress.current === target)
        setError(e instanceof Error ? e.message : "Unable to read Devnet.");
    } finally {
      if (currentAddress.current === target) setLoading(false);
    }
  }, [address]);
  // Synchronize the selected wallet with its external RPC state after hydration.
  /* eslint-disable react-hooks/set-state-in-effect -- Hydrate browser-only wallet storage and synchronize external RPC state. */
  useEffect(() => {
    currentAddress.current = address;
    setData(null);
    setReview(null);
    void refresh();
  }, [address, refresh]);
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
        kind,
        amount: kind === "supply" ? supply : cash,
        collateral,
      });
      if (r.network !== "solana:devnet" || r.wallet !== currentAddress.current)
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
      if (review.wallet !== address || Date.now() > review.expiresAt)
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
    projectedCollateral > 0 ? projectedDebt / (projectedCollateral * 200) : 0;
  const badBorrow =
    !Number.isFinite(projectedLtv) ||
    Number(collateral) <= 0 ||
    Number(cash) <= 0 ||
    projectedLtv > 0.5 ||
    (w !== null && w !== undefined && Number(collateral) > w.stock);
  const ltv = p && p.collateral > 0 ? p.debt / (p.collateral * 200) : 0;

  return (
    <>
      <header className="topbar">
        <Link className="wordmark" href="/">
          <Layers3 size={25} />
          stockroom<span>/</span>
        </Link>
        <nav className="primary-nav" aria-label="Main navigation">
          <a href="/devnet" className="devnet-nav-active">
            Devnet app
          </a>
          <Link href="/">
            Market research <ArrowUpRight size={13} />
          </Link>
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
              <strong>Working Devnet demo.</strong> Demo stocks and demo USD
              have no monetary value. Stockroom’s own credit contract executes
              every action.
            </span>
          </div>
          <a
            href={explorer("address", deployment.creditProgram)}
            target="_blank"
            rel="noreferrer"
          >
            View program <ExternalLink size={13} />
          </a>
        </div>
        <div className="workspace-heading">
          <div>
            <p className="eyebrow">STOCKROOM CREDIT / INTERACTIVE DEMO</p>
            <h1>Keep your stocks. Access cash.</h1>
            <p>
              Deposit demo stocks, borrow demo USD, then repay to release your
              collateral.
            </p>
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
        {error && (
          <div className="input-error" role="alert">
            {error}
            {error.includes("Sign in") && (
              <>
                {" "}
                <a
                  className="text-link"
                  href="/signin-with-chatgpt?return_to=%2Fdevnet"
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
        <div className="devnet-grid">
          <div className="devnet-main">
            <section className="card devnet-start">
              <div className="section-title">
                <div>
                  <p className="eyebrow">START HERE</p>
                  <h2>
                    {address
                      ? "Your Devnet wallet"
                      : "Try a complete lending cycle"}
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
                    Create a temporary wallet in this tab. Claim test assets and
                    make your first loan in a few clicks.
                  </p>
                  <div className="devnet-buttons">
                    <Button
                      onClick={() => void startDemo()}
                      disabled={disabled}
                    >
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
                      label="Demo stocks"
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
                      One starter pack per wallet: 25 demo stocks, 1,000 demo
                      USD and 0.005 Devnet SOL. Account setup uses part of that
                      SOL.
                    </p>
                  )}
                </>
              )}
            </section>
            <section className="outlook-card devnet-position">
              <div className="section-title">
                <div>
                  <p className="eyebrow">YOUR POSITION</p>
                  <h2>
                    {hasLoan ? "A loan you can manage" : "Ready when you are"}
                  </h2>
                </div>
                <ShieldCheck size={22} />
              </div>
              <div className="devnet-position-metrics">
                <Stat
                  label="Collateral deposited"
                  value={num(p?.collateral, 4)}
                  sub="demo stocks"
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
                Repayment closes your debt, including interest. You can then
                release all collateral in a separate transaction.
              </p>
            </section>
            <section className="card devnet-activity">
              <div className="section-title">
                <h2>Transaction receipts</h2>
                <span className="provider">Solana Devnet</span>
              </div>
              {!activeRecords.length ? (
                <p className="devnet-copy">
                  Your signed transactions will appear here, with links to the
                  onchain receipts.
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
          </div>
          <aside className="devnet-sidebar">
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
                    Deposit demo stocks
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
                    <span>STOCK</span>
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
                      200 demo USD
                    </Detail>
                    <Detail label="Loan-to-value after borrowing">
                      {num(projectedLtv * 100, 1)}%
                    </Detail>
                    <Detail label="Borrow APR">5.00%</Detail>
                    <Detail label="Origination fee">0 demo USD</Detail>
                  </dl>
                  {badBorrow && (
                    <p className="input-error">
                      Choose available collateral and a loan within 50% of its
                      value.
                    </p>
                  )}
                  <Button
                    className="primary-action"
                    disabled={
                      disabled || badBorrow || !p?.exists || !!data?.paused
                    }
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
                    Supply demo USD to the lending pool. Your shares track your
                    claim on its assets.
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
                    <Detail label="Supplier yield">
                      Varies with utilization
                    </Detail>
                    <Detail label="Withdrawal">
                      Subject to available cash
                    </Detail>
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
            <section className="devnet-notes">
              <p className="eyebrow">WHAT IS REAL IN THIS DEMO?</p>
              <p>
                Wallet signatures, SPL token transfers, collateral custody,
                lending shares and debt accounting execute on Solana Devnet.
              </p>
              <p>
                The stock price is a fixed, administrator-controlled test feed
                at 200 demo USD. It refreshes with borrowing transactions. These
                tokens do not represent real equities or redeemable dollars.
              </p>
              <p>
                The programs are upgradeable and have not been independently
                audited.
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
          </aside>
        </div>
        <footer>
          <span>Stockroom credit · Test assets only</span>
          <span>
            {data
              ? "Read at slot " + data.slot.toLocaleString()
              : "Connecting to Solana Devnet…"}
          </span>
        </footer>
      </main>
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
                {Object.entries(review.limits)
                  .filter(([k]) => !k.includes("Shares"))
                  .map(([k, v]) => (
                    <Detail
                      key={k}
                      label={
                        (
                          {
                            stock: "Receive demo stocks",
                            cash:
                              review.kind === "faucet"
                                ? "Receive demo USD"
                                : "Demo USD amount",
                            collateral:
                              review.kind === "withdraw"
                                ? "Release demo stocks"
                                : "Deposit demo stocks",
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
