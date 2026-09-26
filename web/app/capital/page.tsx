"use client";
import { RefreshCw } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import Link from "@/app/plain-link";
import { TokenName } from "@/app/token-identity";
import { LiveWallet, useLive } from "@/app/onchain/live-session";
import { WalletConnectButton } from "@/app/onchain/wallet-connect";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { earningsTotals } from "@/lib/treasury/creator-earnings";
import { formatUnits } from "@/lib/treasury/units";
import { TokenCard, useCreatorTokens } from "./creator-tokens";

// "0.12 mSPY · 0.03 mQQQ": one amount per stock, or a dash.
function PerStock({ totals }: { totals: Map<string, bigint> }) {
  if (!totals.size) return <>—</>;
  return (
    <span className="creator-amounts">
      {[...totals].map(([stock, atoms]) => (
        <span key={stock}>
          {formatUnits(atoms)} <TokenName symbol={stock} size={18} />
        </span>
      ))}
    </span>
  );
}

// A wallet address from ?wallet=, or "" when absent or not an address.
function walletParam(value: string | null) {
  if (!value) return "";
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return "";
  }
}

/**
 * My tokens: every token a wallet launched, what it has paid out, and what is
 * waiting. The connected wallet's by default; ?wallet=<address> shows anyone's,
 * read-only apart from the permissionless Collect.
 */
export default function CreatorPage() {
  const { address: connected } = useLive();
  const viewed = walletParam(useSearchParams().get("wallet"));
  const address = viewed || connected;
  const own = !!connected && address === connected;
  const { tokens, error, loading, listing, refresh } = useCreatorTokens(address);
  const ready = tokens.filter((t) => t.earnings);
  const totals = earningsTotals(ready.map((t) => ({ stock: t.stock, earnings: t.earnings! })));
  const graduated = tokens.filter((t) => t.state?.migrated).length;
  return (
    <>
      <div className="sr-heading">
        <div>
          <span className="sr-eyebrow">SONATA / CREATOR</span>
          <h1>{own || !address ? "My tokens" : `Tokens of ${address.slice(0, 4)}…${address.slice(-4)}`}</h1>
          <p>{own || !address ? "What your tokens have paid you, and what is waiting." : "Read-only: what this wallet's tokens have paid it, and what is waiting."}</p>
        </div>
        <Button variant="outline" disabled={!address || loading} onClick={refresh}>
          <RefreshCw />
          Refresh
        </Button>
      </div>
      <LiveWallet />
      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!address ? (
        <Card className="sr-panel creator-empty">
          <h3>Connect the wallet you launched with</h3>
          <WalletConnectButton />
        </Card>
      ) : (
        <>
          <Card className="sr-panel creator-summary">
            <span className="sr-eyebrow">EARNINGS</span>
            <div>
              <div className="sr-detail-row">
                <span>Tokens</span>
                <strong>
                  {listing ? "Reading…" : `${tokens.length} · ${graduated} graduated${loading ? " · reading…" : ""}`}
                </strong>
              </div>
              <div className="sr-detail-row">
                <span>Earned so far</span>
                <strong>
                  <PerStock totals={totals.earned} />
                </strong>
              </div>
              <div className="sr-detail-row">
                <span>Share waiting</span>
                <strong>
                  <PerStock totals={totals.yourWaiting} />
                </strong>
              </div>
              <div className="sr-detail-row">
                <span>Pool fees to claim</span>
                <strong>
                  <PerStock totals={totals.poolToClaim} />
                </strong>
              </div>
              {totals.reserve.size > 0 && (
                <div className="sr-detail-row">
                  <span>In your reserves</span>
                  <strong>
                    <PerStock totals={totals.reserve} />
                  </strong>
                </div>
              )}
              <div className="sr-detail-row">
                <span>Auto payout</span>
                <strong>Every 15 min, straight to the payout wallet</strong>
              </div>
            </div>
          </Card>
          {!listing && !loading && !tokens.length ? (
            <Card className="sr-panel creator-empty">
              <h3>No tokens from this wallet yet</h3>
              {own && (
                <Button asChild>
                  <Link href="/create">Launch a token</Link>
                </Button>
              )}
            </Card>
          ) : (
            <div className="creator-tokens">
              {tokens.map((t) => (
                <TokenCard key={t.market.treasury} token={t} viewer={address} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
