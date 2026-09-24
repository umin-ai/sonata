"use client";
import { WalletPicker } from "./wallet-connect";
import { TokenName } from "@/app/token-identity";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Buffer } from "buffer";
import { Keypair, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import { useWallet } from "@/hooks/use-wallet";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ArrowUpRight, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  isRewardMarket,
  connection,
  market,
  explorer,
  type PreparedTreasury,
} from "@/lib/treasury/runtime";
import { formatUnits } from "@/lib/treasury/units";
import { quoteSymbolOf } from "@/lib/treasury/quote-assets";
const storagePrefix = `stockroom.session.${market.programId}`;
const short = (s: string) => `${s.slice(0, 5)}…${s.slice(-5)}`;
// Where a bot-run market's 50% goes, by the fee model in its metadata.
const botShare = (model?: string) =>
  ({
    buyback: "50% to buy back your token and burn it",
    topBuyers: "50% to each round's top 3 net buyers",
    lpFarm: "50% to holders, then to liquidity providers after graduation",
    split: "50% split between your wallets",
    diamond: "50% to holders, weighted by how long they hold",
  })[model ?? ""] ?? "50% to holders, paid in the stock";
const names = {
  "creator-claim": "Claim graduated pool fees",
  graduate: "Graduate to Meteora pool",
  "reward-policy": "Configure holder rewards",
  "reward-deliver": "Deliver holder payout",
  "reserve-deploy": "Deploy creator reserve",
  "reward-fund": "Fund community rewards",
  "reward-claim": "Claim community reward",
  "lp-buy": "Buy in Meteora pool",
  "lp-sell": "Sell in Meteora pool",
  "lp-deposit": "Supply liquidity",
  "lp-withdraw": "Withdraw liquidity",
  "lp-claim": "Claim pool fees",
  buy: "Buy community tokens",
  sell: "Sell community tokens",
  withdraw: "Withdraw creator reserve",
  launch: "Create Devnet market",
  register: "Activate treasury",
  collect: "Collect trading fees",
  allocate: "Allocate collected fees",
  redeem: "Burn tokens for stock",
  sync: "Add new fees to the backing",
};
import { LiveContext, useLive, type Pending } from "./live-context";
import { signedChange } from "@/lib/treasury/signed-check";
export { useLive } from "./live-context";
// An amount in a review window: the number, then the token's logo and ticker,
// kept together on one line and grouped by thousands (177,316,147.761803).
const grouped = (text: string) => {
  const [whole, fraction] = text.split(".");
  return `${BigInt(whole || "0").toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
};
function Amount({ atoms, decimals, symbol }: { atoms: string | bigint; decimals: number; symbol: string }) {
  return (
    <span className="review-amount">
      <span>{grouped(formatUnits(atoms, decimals))}</span>
      <TokenName symbol={symbol} size={18} />
    </span>
  );
}

// One line of a review window: what, then its value.
function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="sr-detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet("solana:devnet", true),
    [walletOpen, setWalletOpen] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [review, setReview] = useState<PreparedTreasury | null>(null),
    [pending, setPending] = useState<Pending | null>(null),
    [testAddress, setTestAddress] = useState(""),
    [labels, setLabels] = useState<Record<string, string>>({}),
    [revision, setRevision] = useState(0);
  const testKey = useRef<Keypair | null>(null),
    lock = useRef(false),
    address = wallet.account?.address ?? testAddress,
    currentAddress = useRef(address);
  // Amounts in the review are in this market's quote token, not always mSPY.
  const quoteSymbol = review?.market
    ? quoteSymbolOf(review.market.quoteMint)
    : review?.trade
      ? review.action === "sell"
        ? review.trade.outputSymbol
        : review.trade.inputSymbol
      : "mSPY";
  useEffect(() => {
    currentAddress.current = address;
  }, [address]);
  useEffect(() => {
    try {
      const savedLabels = JSON.parse(
        localStorage.getItem(`${storagePrefix}.labels`) ?? "{}",
      );
      if (savedLabels && typeof savedLabels === "object")
        setLabels(
          Object.fromEntries(
            Object.entries(savedLabels).filter(
              ([key, value]) =>
                /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(key) &&
                typeof value === "string" &&
                value.length < 70,
            ),
          ) as Record<string, string>,
        );
      const saved = JSON.parse(
        localStorage.getItem(`${storagePrefix}.pending`) ?? "null",
      );
      if (
        saved &&
        /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(saved.signature) &&
        Number.isSafeInteger(saved.lastValidBlockHeight)
      )
        setPending(saved);
    } catch {}
    try {
      if (sessionStorage.getItem("stockroom.devnet.connected") === "true")
        useTestWallet();
    } catch {}
  }, []);
  const remember = (value: Pending | null) => {
    // Persist the receipt before broadcasting. Failure must stop sending, not erase recovery.
    if (value) {
      try {
        localStorage.setItem(`${storagePrefix}.pending`, JSON.stringify(value));
      } catch {
        throw Error(
          "Browser storage cannot save the transaction receipt. Nothing was sent.",
        );
      }
    } else {
      try {
        localStorage.removeItem(`${storagePrefix}.pending`);
      } catch {}
    }
    setPending(value);
  };
  const check = async (p: Pending) => {
    const status = (
      await connection.getSignatureStatuses([p.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (status?.err) {
      remember(null);
      throw Error(
        "The transaction failed onchain. No success is being reported.",
      );
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      remember(null);
      if (p.action && p.action in names)
        setLabels((previous) => {
          const next = { ...previous, [p.signature]: names[p.action!] };
          try {
            localStorage.setItem(
              `${storagePrefix}.labels`,
              JSON.stringify(next),
            );
          } catch {}
          return next;
        });
      toast.success("Confirmed on Solana Devnet");
      if (p.action === "register") {
        const draft = JSON.parse(
          localStorage.getItem("stockroom.launch.draft") ?? "null",
        );
        if (draft?.pool)
          localStorage.setItem("stockroom.last-created", draft.pool);
        localStorage.removeItem("stockroom.launch.draft");
      }
      setRevision((v) => v + 1);
      return true;
    }
    if (
      !status &&
      (await connection.getBlockHeight("confirmed")) > p.lastValidBlockHeight
    ) {
      remember(null);
      throw Error(
        "The transaction expired without confirmation. Review a new action.",
      );
    }
    return false;
  };
  // Resolve a pending transaction on its own: confirmed, failed or expired.
  // Without this the app stays paused until "Check receipt" is pressed.
  useEffect(() => {
    if (!pending || busy) return;
    let active = true;
    const timer = setInterval(() => {
      void check(pending).catch((e) => {
        if (active)
          setError(e instanceof Error ? e.message : "Transaction status unavailable.");
      });
    }, 8000);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // check reads only stable setters and the connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, busy]);
  async function execute(build: () => Promise<PreparedTreasury>, options: { direct?: boolean } = {}) {
    if (lock.current || pending || !address) return;
    lock.current = true;
    setBusy("Verifying and simulating transaction…");
    setError("");
    let prepared: PreparedTreasury | null = null;
    try {
      prepared = await build();
      if (prepared.wallet !== currentAddress.current)
        throw Error("Wallet changed during preparation.");
      // A swap goes straight to the wallet, as on other launchpads; everything
      // else is reviewed first. The wallet's own approval gets a minute.
      if (options.direct) prepared = { ...prepared, expiresAt: Date.now() + 60_000 };
      else setReview(prepared);
    } catch (e) {
      prepared = null;
      setError(
        e instanceof Error ? e.message : "Unable to prepare transaction.",
      );
    } finally {
      setBusy("");
      lock.current = false;
    }
    if (options.direct && prepared) await confirm(prepared);
  }
  // Signs and sends a prepared transaction: the one in the review window, or,
  // for a swap, straight from its button (the wallet's own approval is the check).
  async function confirm(target: PreparedTreasury | null = review) {
    const review = target;
    if (!review || lock.current) return;
    lock.current = true;
    setBusy("Waiting for wallet signature…");
    setError("");
    let submitted: Pending | null = null;
    try {
      if (
        review.wallet !== currentAddress.current ||
        Date.now() > review.expiresAt
      )
        throw Error(
          "Wallet changed or review expired. Prepare a fresh review.",
        );
      // One approval covers the reviewed transaction and any bundled after it.
      const steps = [
        { transaction: review.transaction, action: review.action },
        ...(review.bundle ?? []),
      ];
      const unsigned = steps.map((step) =>
          Transaction.from(Buffer.from(step.transaction, "base64")),
        ),
        messages = unsigned.map((tx) => tx.serializeMessage());
      let signed: Transaction[];
      if (!wallet.account && testKey.current) {
        for (const tx of unsigned) tx.partialSign(testKey.current);
        signed = unsigned;
      } else {
        const feature = wallet.wallet?.features as
          Partial<SolanaSignTransactionFeature> | undefined;
        if (!feature?.["solana:signTransaction"] || !wallet.account)
          throw Error("A wallet that signs Devnet transactions is required.");
        const account = wallet.account;
        const results = await feature["solana:signTransaction"].signTransaction(
          ...steps.map((step) => ({
            account,
            chain: "solana:devnet" as const,
            transaction: Uint8Array.from(Buffer.from(step.transaction, "base64")),
          })),
        );
        signed = results.map((r) => Transaction.from(r.signedTransaction));
      }
      if (review.wallet !== currentAddress.current)
        throw Error("The wallet changed while signing. Nothing sent.");
      if (Date.now() > review.expiresAt)
        throw Error("The quote expired before the wallet approved it. Nothing sent; try again.");
      if (signed.length !== steps.length)
        throw Error("The wallet returned a different number of transactions. Nothing sent.");
      for (let i = 0; i < signed.length; i++) {
        // The test wallet signs our own objects; an extension wallet may add its
        // own priority fee or Lighthouse checks, and nothing else.
        const change = signed[i] === unsigned[i] ? (signed[i].serializeMessage().equals(messages[i]) ? null : "it changed") : signedChange(unsigned[i], signed[i]);
        if (change) throw Error(`The wallet changed the transaction: ${change}. Nothing sent.`);
        if (!signed[i].verifySignatures())
          throw Error("A signature on the transaction doesn't check out. Nothing sent.");
      }
      if (review.action === "launch" && review.market)
        localStorage.setItem(
          "stockroom.launch.draft",
          JSON.stringify(review.market),
        );
      setReview(null);
      // Each step depends on the one before it, so each is sent only after the
      // previous one confirms. A failure stops the rest; a saved launch draft
      // lets the creator finish it.
      for (let i = 0; i < signed.length; i++) {
        submitted = {
          signature: bs58.encode(signed[i].signature!),
          lastValidBlockHeight: review.lastValidBlockHeight,
          wallet: review.wallet,
          action: steps[i].action,
        };
        remember(submitted);
        setBusy(
          signed.length > 1
            ? `Submitting ${i + 1} of ${signed.length} to Solana Devnet…`
            : "Submitting to Solana Devnet…",
        );
        // Every transaction was simulated when its review opened, or depends on
        // one that was. Skipping the send-time preflight avoids public Devnet's
        // "Blockhash not found" when the request lands on an RPC node a few slots
        // behind; the result is still checked below and a failure is reported
        // with its receipt.
        await connection.sendRawTransaction(signed[i].serialize(), {
          skipPreflight: true,
          maxRetries: 5,
        });
        setBusy(
          signed.length > 1
            ? `Waiting for confirmation ${i + 1} of ${signed.length}…`
            : "Waiting for network confirmation…",
        );
        const result = await connection.confirmTransaction(
          {
            signature: submitted.signature,
            blockhash: review.blockhash,
            lastValidBlockHeight: review.lastValidBlockHeight,
          },
          "confirmed",
        );
        if (result.value.err)
          throw Error("Transaction failed onchain. Check its receipt.");
        await check(submitted);
      }
    } catch (e) {
      setReview(null);
      setError(
        (e instanceof Error ? e.message : "Transaction interrupted.") +
          (submitted
            ? " The signature is saved below. Check its status before another action."
            : ""),
      );
    } finally {
      setBusy("");
      lock.current = false;
    }
  }
  function useTestWallet() {
    try {
      const stored = sessionStorage.getItem("stockroom.devnet.wallet.v1");
      const key = stored
        ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)))
        : Keypair.generate();
      if (!stored)
        sessionStorage.setItem(
          "stockroom.devnet.wallet.v1",
          JSON.stringify([...key.secretKey]),
        );
      sessionStorage.setItem("stockroom.devnet.connected", "true");
      testKey.current = key;
      setTestAddress(key.publicKey.toBase58());
      setReview(null);
    } catch {
      setError(
        "Browser wallet storage is unavailable. Connect an extension wallet.",
      );
    }
  }
  async function connectWallet(selected: Parameters<typeof wallet.connect>[0]) {
    if (busy) return false;
    const connected = await wallet.connect(selected);
    if (connected) {
      setTestAddress("");
      testKey.current = null;
      setReview(null);
      try {
        sessionStorage.removeItem("stockroom.devnet.connected");
      } catch {}
    }
    return connected;
  }
  function disconnect() {
    void wallet.disconnect();
    setTestAddress("");
    testKey.current = null;
    setReview(null);
    sessionStorage.removeItem("stockroom.devnet.connected");
  }
  return (
    <LiveContext.Provider
      value={{
        wallet,
        address,
        busy,
        pending,
        error,
        revision,
        labels,
        execute,
        useTestWallet,
        walletOpen,
        setWalletOpen,
        connectWallet,
        disconnect,
      }}
    >
      {children}
      <WalletPicker />
      <div className="fixed bottom-5 right-5 z-50 max-w-lg px-4">
        {" "}
        {pending && (
          <Alert className="mb-6">
            <AlertDescription>
              <span>
                A submitted transaction needs confirmation. Further actions are
                paused.
              </span>
              <a
                className="sr-text-link"
                href={explorer("tx", pending.signature)}
                target="_blank"
                rel="noreferrer"
              >
                Inspect submitted transaction <ArrowUpRight size={14} />
              </a>
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={async () => {
                  setBusy("Checking receipt…");
                  try {
                    if (!(await check(pending)))
                      setError(
                        "Still pending. Check again before submitting another action.",
                      );
                  } catch (e) {
                    setError(
                      e instanceof Error
                        ? e.message
                        : "Unable to check receipt.",
                    );
                  } finally {
                    setBusy("");
                  }
                }}
              >
                Check receipt
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </div>{" "}
      <Dialog
        open={!!review}
        onOpenChange={(open) => !busy && !open && setReview(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {review ? (review.title ?? names[review.action]) : ""}
            </DialogTitle>
            <DialogDescription>
              Solana Devnet · actual test-token transaction
            </DialogDescription>
          </DialogHeader>
          {review && (
            <>
              {review.redeem && (
                <div className="review-facts">
                  <div className="sr-detail-row">
                    <span>You burn</span>
                    <strong>
                      {formatUnits(review.redeem.burn, 6)}{" "}
                      <TokenName symbol={review.redeem.baseSymbol} />
                    </strong>
                  </div>
                  <div className="sr-detail-row">
                    <span>You receive</span>
                    <strong>
                      {formatUnits(review.redeem.payout)}{" "}
                      <TokenName symbol={quoteSymbol} />
                    </strong>
                  </div>
                </div>
              )}
              {!review.liquidity &&
                !review.redeem &&
                !review.graduation &&
                review.action !== "launch" &&
                review.action !== "register" && (
                  <p className="text-2xl">
                    {formatUnits(review.raw, review.trade?.inputDecimals ?? 8)}{" "}
                    <TokenName symbol={review.trade?.inputSymbol ?? quoteSymbol} />
                  </p>
                )}
              {review.liquidity && (
                <div className="review-facts">
                  <div className="sr-detail-row">
                    <span>
                      {review.liquidity.kind === "deposit"
                        ? "Estimated supply"
                        : review.liquidity.kind === "claim"
                          ? "Fees to claim"
                          : "Estimated receive"}
                    </span>
                    <strong className="review-amounts">
                      {/* A claim from a stock-only fee pool has no token side. */}
                      {(review.liquidity.kind !== "claim" || review.liquidity.a !== "0") && (
                        <Amount atoms={review.liquidity.a} decimals={review.liquidity.decimalsA ?? 6} symbol={review.liquidity.symbolA ?? "ROOM"} />
                      )}
                      <Amount atoms={review.liquidity.b} decimals={review.liquidity.decimalsB ?? 8} symbol={review.liquidity.symbolB ?? "mSPY"} />
                    </strong>
                  </div>
                  {review.liquidity.kind !== "claim" && (
                  <div className="sr-detail-row">
                    <span>
                      {review.liquidity.kind === "deposit"
                        ? "Maximum debit"
                        : "Minimum receive"}
                    </span>
                    <strong className="review-amounts">
                      <Amount atoms={review.liquidity.limitA} decimals={review.liquidity.decimalsA ?? 6} symbol={review.liquidity.symbolA ?? "ROOM"} />
                      <Amount atoms={review.liquidity.limitB} decimals={review.liquidity.decimalsB ?? 8} symbol={review.liquidity.symbolB ?? "mSPY"} />
                    </strong>
                  </div>
                  )}
                  {review.liquidity.kind === "deposit" && (
                    <>
                      <Fact label="You get" value="A position NFT · withdraw any time" />
                      <Fact label="Fees" value={review.liquidity.compounding ? "Added back into the pool" : "Earned by the position · claim any time"} />
                    </>
                  )}
                  {review.liquidity.kind === "withdraw" && (
                    <>
                      <Fact label="You keep" value="The position NFT" />
                      <Fact label="Fees" value={review.liquidity.compounding ? "Included" : "Stay on the position · claim separately"} />
                    </>
                  )}
                  {review.liquidity.kind === "claim" && <Fact label="Liquidity" value="Stays in the pool" />}
                  {review.liquidity.kind !== "claim" && (
                    <>
                      <Fact label="Slippage limit" value="0.5% on both tokens" />
                      <Fact label="Risk" value="Price moves change what you get back" />
                    </>
                  )}
                </div>
              )}
              {review.rewards && (
                <div className="review-facts">
                  <p className="sr-note">{review.rewards.description}</p>
                  {review.rewards.allocations.map((a) => (
                    <div className="sr-detail-row" key={a.recipient}>
                      <span className="break-all">{a.recipient}</span>
                      <strong className="review-amounts">
                        <Amount atoms={a.amount} decimals={8} symbol="mSPY" />
                      </strong>
                    </div>
                  ))}
                </div>
              )}
              {review.trade && (
                <div className="review-facts">
                  <div className="sr-detail-row">
                    <span>Estimated receive</span>
                    <strong className="review-amounts">
                      <Amount atoms={review.trade.expectedOut} decimals={review.trade.outputDecimals} symbol={review.trade.outputSymbol} />
                    </strong>
                  </div>
                  <div className="sr-detail-row">
                    <span>Minimum receive</span>
                    <strong className="review-amounts">
                      <Amount atoms={review.trade.minimumOut} decimals={review.trade.outputDecimals} symbol={review.trade.outputSymbol} />
                    </strong>
                  </div>
                  <div className="sr-detail-row">
                    <span>Trading + protocol fees (included)</span>
                    <strong>
                      {formatUnits(
                        BigInt(review.trade.tradingFee) +
                          BigInt(review.trade.protocolFee),
                      )}{" "}
                      {quoteSymbol}
                    </strong>
                  </div>
                  <p className="sr-note">
                    0.5% slippage limit. Output goes to your wallet. If the
                    minimum cannot be met, the transaction fails rather than
                    accepting a worse price.
                  </p>
                </div>
              )}
              {review.graduation && (
                <div className="review-facts">
                  {review.graduation.fees !== "0" && (
                    <Fact label="Collects the curve fees" value={<Amount atoms={review.graduation.fees} decimals={review.market?.quoteDecimals ?? 8} symbol={quoteSymbol} />} />
                  )}
                  <Fact label={review.graduation.fees !== "0" ? "Then" : "Creates"} value="Its Meteora DAMM v2 pool" />
                  <Fact label="Liquidity" value="Locked forever · half creator, half Sonata" />
                  <Fact label="Trading" value="Moves to the pool; the curve closes" />
                </div>
              )}
              {!review.liquidity && !review.graduation && (
              <p className="sr-note">
                {review.rewards
                  ? "Only the named recipient can claim each fixed allocation, once. This is funded mock stock, not a promised investment return."
                    : review.action === "launch"
                      ? `${review.bundle ? `One approval, ${review.bundle.length + 1} transactions sent in order: this launch's Meteora config, then the token and its pool${review.devBuy ? `, with your first buy of ${review.devBuy.quoteAmount} ${review.devBuy.quote} for about ${review.devBuy.percent.toFixed(2)}% of the supply as its very first trade, in the same transaction, so nothing trades before you` : ""}, then the Sonata treasury. ` : "Create a permanent token and its own Meteora pool with the trading fee you chose. "}Net collected fees go ${review.market && isRewardMarket(review.market) ? `${botShare(review.market.feeModel)}, run by Sonata's payout bot every 15 minutes, and 50% to Sonata` : review.market?.mode === "standardFloor" ? "25% to your fixed recipient, 25% into the backing, which only holders can redeem, and 50% to Sonata" : review.market?.mode === "standard" ? "50% to your fixed recipient and 50% to Sonata" : review.market?.mode === "floor" ? "50% to your fixed recipient and 50% into the backing, which only holders can redeem" : review.market?.mode === "refrain" ? "100% to your fixed recipient" : "50% to your fixed recipient and 50% to the creator reserve"}. At graduation you get half of the locked pool, which keeps earning fees.${review.bundle ? "" : " A second signature activates the treasury."}`
                      : review.action === "register"
                        ? review.market?.mode === "standard" || review.market?.mode === "standardFloor"
                          ? "Register the creator, immutable recipient and fee split in Sonata, and create its custody accounts."
                          : review.market?.mode === "floor"
                          ? "Register the creator, immutable recipient and backing in Sonata, and create its custody accounts. Once active, the creator can never withdraw the backing."
                          : review.market?.mode === "refrain"
                            ? "Register the creator and immutable recipient in Sonata, and create its custody accounts. Every net fee collected goes to the recipient."
                            : "Register the creator, immutable recipient and 50/50 allocation in Sonata, and create its custody accounts."
                        : review.action === "creator-claim"
                          ? "Claims the trading fees your locked graduated pool position has earned, into your own token accounts. The position stays locked."
                        : review.action === "redeem"
                          ? "Your tokens are burned and you receive their exact share of the backing: backing × tokens burned ÷ total supply, rounded down. Nobody else's share goes down."
                        : review.action === "sync"
                          ? `Collects new trading fees from Meteora and splits them: ${review.market?.mode === "standardFloor" ? "25% to the fixed recipient, 25% into the backing, 50% to Sonata" : "50% to the fixed recipient, 50% into the backing"}. Anyone can do this; you only pay the network fee.`
                        : review.action === "withdraw"
                          ? "Move the requested allocated reserve to the creator’s wallet. No holder balances are redeemed."
                          : review.action === "allocate"
                            ? review.market?.mode === "standard"
                              ? "50% goes to the fixed recipient and 50% to Sonata."
                              : review.market?.mode === "refrain"
                                ? "100% goes to the fixed recipient."
                                : "50% goes to the fixed recipient and 50% remains retained."
                            : review.action === "collect"
                              ? "All currently claimable partner fees move into treasury custody. The final amount may change if more trades occur."
                              : review.action === "lp-buy" ||
                                  review.action === "lp-sell"
                                ? "This trade uses the token's Meteora DAMM v2 pool. Its fee, less Meteora's share, goes to the pool's liquidity providers: the creator and Sonata's locked halves (Sonata's half keeps paying the token's fee model) and anyone who adds liquidity. Test assets, with no real stock exposure."
                                : "This trade changes your token balances and earns fees for the pool. It does not deposit into the creator reserve."}
              </p>
              )}
              <div className="review-facts">
                <Fact
                  label={review.recipient === review.wallet ? "To" : review.liquidity ? "Pool" : "Destination"}
                  value={
                    review.recipient === review.wallet ? (
                      "Your wallet"
                    ) : (
                      <a className="sr-text-link" href={explorer("address", review.recipient)} target="_blank" rel="noreferrer">
                        {review.recipient.slice(0, 4)}…{review.recipient.slice(-4)}
                      </a>
                    )
                  }
                />
                <Fact label="Network fee" value={`${(review.feeLamports / 1e9).toFixed(6)} SOL`} />
                {!!review.rentLamports && (
                  <Fact label="Account rent" value={`${formatUnits(BigInt(review.rentLamports), 9)} SOL`} />
                )}
                <Fact label="Expires in" value={review.trade || review.liquidity ? "30 seconds" : "60 seconds"} />
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => setReview(null)}
                >
                  Cancel
                </Button>
                <Button disabled={!!busy} onClick={() => void confirm()}>
                  {busy ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <CheckCircle2 />
                  )}
                  Sign Devnet transaction
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </LiveContext.Provider>
  );
}
/** Inline transaction feedback only; connection belongs to the shared header. */
export function LiveWallet() {
  const { busy, error } = useLive();
  return (
    <>
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {busy && (
        <div role="status" className="nm-wallet-progress">
          <Loader2 className="animate-spin" size={16} />
          {busy}
        </div>
      )}
    </>
  );
}
