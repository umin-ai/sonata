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
  connection,
  market,
  explorer,
  type PreparedTreasury,
} from "@/lib/treasury/runtime";
import { formatUnits } from "@/lib/treasury/units";
import { quoteSymbolOf } from "@/lib/treasury/quote-assets";
const storagePrefix = `stockroom.session.${market.programId}`;
const short = (s: string) => `${s.slice(0, 5)}…${s.slice(-5)}`;
const names = {
  "creator-claim": "Claim graduated pool fees",
  "reward-policy": "Configure holder rewards",
  "reward-deliver": "Deliver holder payout",
  "reserve-deploy": "Deploy creator reserve",
  "reward-fund": "Fund community rewards",
  "reward-claim": "Claim community reward",
  "lp-buy": "Buy ROOM in liquidity pool",
  "lp-sell": "Sell ROOM in liquidity pool",
  "lp-deposit": "Supply liquidity",
  "lp-withdraw": "Withdraw liquidity",
  buy: "Buy community tokens",
  sell: "Sell community tokens",
  withdraw: "Withdraw creator reserve",
  launch: "Create Devnet market",
  register: "Activate treasury",
  collect: "Collect trading fees",
  allocate: "Allocate collected fees",
  redeem: "Burn tokens for stock",
  sync: "Add new fees to the Stock Floor",
};
import { LiveContext, useLive, type Pending } from "./live-context";
export { useLive } from "./live-context";
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
  async function execute(build: () => Promise<PreparedTreasury>) {
    if (lock.current || pending || !address) return;
    lock.current = true;
    setBusy("Verifying and simulating transaction…");
    setError("");
    try {
      const prepared = await build();
      if (prepared.wallet !== currentAddress.current)
        throw Error("Wallet changed during preparation.");
      setReview(prepared);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to prepare transaction.",
      );
    } finally {
      setBusy("");
      lock.current = false;
    }
  }
  async function confirm() {
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
      if (
        review.wallet !== currentAddress.current ||
        Date.now() > review.expiresAt ||
        signed.length !== steps.length ||
        signed.some(
          (tx, i) => !tx.serializeMessage().equals(messages[i]) || !tx.verifySignatures(),
        )
      )
        throw Error(
          "Signed transaction does not match the review. Nothing sent.",
        );
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
                <div className="space-y-3">
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
                review.action !== "launch" &&
                review.action !== "register" && (
                  <p className="text-2xl">
                    {formatUnits(review.raw, review.trade?.inputDecimals ?? 8)}{" "}
                    <TokenName symbol={review.trade?.inputSymbol ?? quoteSymbol} />
                  </p>
                )}
              {review.liquidity && (
                <div className="space-y-3">
                  <div className="sr-detail-row">
                    <span>
                      {review.liquidity.kind === "deposit"
                        ? "Estimated supply"
                        : "Estimated receive"}
                    </span>
                    <strong>
                      {formatUnits(review.liquidity.a, review.liquidity.decimalsA ?? 6)}{" "}
                      <TokenName symbol={review.liquidity.symbolA ?? "ROOM"} />
                      <br />
                      {formatUnits(review.liquidity.b, review.liquidity.decimalsB ?? 8)}{" "}
                      <TokenName symbol={review.liquidity.symbolB ?? "mSPY"} />
                    </strong>
                  </div>
                  <div className="sr-detail-row">
                    <span>
                      {review.liquidity.kind === "deposit"
                        ? "Maximum debit"
                        : "Minimum receive"}
                    </span>
                    <strong>
                      {formatUnits(review.liquidity.limitA, review.liquidity.decimalsA ?? 6)}{" "}
                      <TokenName symbol={review.liquidity.symbolA ?? "ROOM"} />
                      <br />
                      {formatUnits(review.liquidity.limitB, review.liquidity.decimalsB ?? 8)}{" "}
                      <TokenName symbol={review.liquidity.symbolB ?? "mSPY"} />
                    </strong>
                  </div>
                  <p className="sr-note">{review.liquidity.description}</p>
                  <p className="sr-note">
                    0.5% slippage protection on both assets. Expires in 30
                    seconds.
                  </p>
                </div>
              )}
              {review.rewards && (
                <div className="space-y-3">
                  <p className="sr-note">{review.rewards.description}</p>
                  {review.rewards.allocations.map((a) => (
                    <div className="sr-detail-row" key={a.recipient}>
                      <span className="break-all">{a.recipient}</span>
                      <strong>
                        {formatUnits(a.amount)} <TokenName symbol="mSPY" />
                      </strong>
                    </div>
                  ))}
                </div>
              )}
              {review.trade && (
                <div className="space-y-3">
                  <div className="sr-detail-row">
                    <span>Estimated receive</span>
                    <strong>
                      {formatUnits(
                        review.trade.expectedOut,
                        review.trade.outputDecimals,
                      )}{" "}
                      <TokenName symbol={review.trade.outputSymbol} />
                    </strong>
                  </div>
                  <div className="sr-detail-row">
                    <span>Minimum receive</span>
                    <strong>
                      {formatUnits(
                        review.trade.minimumOut,
                        review.trade.outputDecimals,
                      )}{" "}
                      <TokenName symbol={review.trade.outputSymbol} />
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
              <p className="sr-note">
                {review.rewards
                  ? "Only the named recipient can claim each fixed allocation, once. This is funded mock stock, not a promised investment return."
                  : review.liquidity
                    ? "Full-range liquidity has price and divergence risk. These are valueless mock assets on Devnet."
                    : review.action === "launch"
                      ? `${review.bundle ? `One approval, ${review.bundle.length + 1} transactions sent in order: this launch's Meteora config, then the token and its pool${review.devBuy ? `, with your first buy of ${review.devBuy.quoteAmount} ${review.devBuy.quote} for about ${review.devBuy.percent.toFixed(2)}% of the supply as its very first trade, in the same transaction, so nothing trades before you` : ""}, then the Sonata treasury. ` : "Create a permanent token and its own Meteora pool with the trading fee you chose. "}Net collected fees go ${review.market?.mode === "standardFloor" ? "25% to your fixed recipient, 25% to the Stock Floor, which only holders can redeem, and 50% to Sonata" : review.market?.mode === "standard" ? "50% to your fixed recipient and 50% to Sonata" : review.market?.mode === "floor" ? "50% to your fixed recipient and 50% to the Stock Floor, which only holders can redeem" : review.market?.mode === "refrain" ? "100% to your fixed recipient" : "50% to your fixed recipient and 50% to the creator reserve"}. At graduation you get half of the locked pool, which keeps earning fees.${review.bundle ? "" : " A second signature activates the treasury."}`
                      : review.action === "register"
                        ? review.market?.mode === "standard" || review.market?.mode === "standardFloor"
                          ? "Register the creator, immutable recipient and fee split in Sonata, and create its custody accounts."
                          : review.market?.mode === "floor"
                          ? "Register the creator, immutable recipient and Stock Floor in Sonata, and create its custody accounts. Once active, the creator can never withdraw the floor."
                          : review.market?.mode === "refrain"
                            ? "Register the creator and immutable recipient in Sonata, and create its custody accounts. Every net fee collected goes to the recipient."
                            : "Register the creator, immutable recipient and 50/50 allocation in Sonata, and create its custody accounts."
                        : review.action === "creator-claim"
                          ? "Claims the trading fees your locked graduated pool position has earned, into your own token accounts. The position stays locked."
                        : review.action === "redeem"
                          ? "Your tokens are burned and you receive their exact share of the Stock Floor: floor × tokens burned ÷ total supply, rounded down. Nobody else's share goes down."
                        : review.action === "sync"
                          ? `Collects new trading fees from Meteora and splits them: ${review.market?.mode === "standardFloor" ? "25% to the fixed recipient, 25% into the Stock Floor, 50% to Sonata" : "50% to the fixed recipient, 50% into the Stock Floor"}. Anyone can do this; you only pay the network fee.`
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
                                ? "This trade uses the DAMM pool. Net LP fees compound directly into its reserves; no creator treasury fee is charged by Sonata here."
                                : "This trade changes your token balances and earns fees for the pool. It does not deposit into the creator reserve."}
              </p>
              <p className="sr-note break-all">
                Destination: {review.recipient}
              </p>
              <p className="sr-note">
                Estimated network fee: {(review.feeLamports / 1e9).toFixed(6)}{" "}
                Devnet SOL.
                {review.rentLamports
                  ? ` Estimated account rent: ${formatUnits(BigInt(review.rentLamports), 9)} Devnet SOL.`
                  : ""}
                {review.trade || review.liquidity
                  ? " Review expires after 30 seconds."
                  : " Review expires after 60 seconds."}
              </p>
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
