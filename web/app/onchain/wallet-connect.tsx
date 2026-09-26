"use client";
import { useState } from "react";
import {
  Wallet,
  ChevronDown,
  ArrowUpRight,
  Copy,
  Check,
  LogOut,
  ArrowRightLeft,
  FlaskConical,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useLive } from "./live-context";
import { explorer } from "@/lib/treasury/runtime";
import { toast } from "sonner";
const short = (address: string) =>
  `${address.slice(0, 4)}…${address.slice(-4)}`;

export function WalletConnectButton() {
  const { address, wallet, busy, disconnect, setWalletOpen } = useLive();
  const [copied, setCopied] = useState(false);
  if (!address)
    return (
      <Button
        onClick={() => setWalletOpen(true)}
        disabled={!!busy || wallet.busy}
        className="nm-connect-button"
      >
        <Wallet size={17} />
        Connect wallet
      </Button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="nm-account-button"
          disabled={!!busy || wallet.busy}
          aria-label={`Wallet ${short(address)}`}
        >
          {wallet.wallet?.icon && wallet.account ? (
            <img src={wallet.wallet.icon} width={22} height={22} alt="" />
          ) : (
            <FlaskConical size={17} />
          )}
          <span>{short(address)}</span>
          <ChevronDown size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="nm-account-menu">
        <DropdownMenuLabel>
          <span className="nm-wallet-menu-name">
            {wallet.account ? wallet.wallet?.name : "Test wallet"}
          </span>
          <span className="nm-wallet-network">
            <i />
            Solana Devnet
          </span>
        </DropdownMenuLabel>
        <div className="nm-account-address">{address}</div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async (e) => {
            e.preventDefault();
            try {
              await navigator.clipboard.writeText(address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            } catch {
              toast.error(
                "Could not copy. Select the address above to copy it.",
              );
            }
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy address"}
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a
            href={explorer("address", address)}
            target="_blank"
            rel="noreferrer"
          >
            <ArrowUpRight />
            View on explorer
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setWalletOpen(true)}>
          <ArrowRightLeft />
          Change wallet
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={disconnect}>
          <LogOut />
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WalletPicker() {
  const {
    walletOpen,
    setWalletOpen,
    wallet,
    address,
    busy,
    connectWallet,
    useTestWallet,
    disconnect,
  } = useLive();
  const [connecting, setConnecting] = useState("");
  return (
    <Dialog open={walletOpen} onOpenChange={setWalletOpen}>
      <DialogContent className="nm-wallet-picker">
        <div className="nm-wallet-emblem">
          <Wallet size={25} />
        </div>
        <DialogHeader>
          <DialogTitle>Connect your wallet</DialogTitle>
          <DialogDescription>
            Choose a wallet to get started with Sonata.
          </DialogDescription>
        </DialogHeader>
        <div className="nm-wallet-network">
          <i />
          Solana Devnet<span>Test assets only</span>
        </div>
        {wallet.error && (
          <Alert variant="destructive">
            <AlertDescription>{wallet.error}</AlertDescription>
          </Alert>
        )}
        {wallet.wallets.length ? (
          <div className="nm-wallet-list">
            {wallet.wallets.map((w) => (
              <button
                type="button"
                className="nm-wallet-option"
                key={w.name}
                disabled={wallet.busy || !!busy}
                onClick={async () => {
                  setConnecting(w.name);
                  const ok = await connectWallet(w);
                  setConnecting("");
                  if (ok) setWalletOpen(false);
                }}
              >
                <img src={w.icon} width={36} height={36} alt="" />
                <strong>{w.name}</strong>
                {wallet.busy && connecting === w.name ? (
                  <Loader2 className="animate-spin" size={18} />
                ) : (
                  <span>
                    {wallet.wallet === w && wallet.account
                      ? "Connected"
                      : "Detected"}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="nm-wallet-empty">
            <strong>No compatible wallet detected</strong>
            <p>
              Open Sonata in a browser with a Solana wallet extension, or in
              your wallet’s browser.
            </p>
          </div>
        )}
        {wallet.busy && (
          <p role="status" className="nm-wallet-wait">
            Approve the connection in {connecting || "your wallet"}. You can
            reject the request there.
          </p>
        )}
        <details className="nm-wallet-get" open={!wallet.wallets.length}>
          <summary>Need a wallet?</summary>
          <div>
            <a href="https://phantom.com/" target="_blank" rel="noreferrer">
              Get Phantom <ArrowUpRight size={16} />
            </a>
            <a href="https://solflare.com/" target="_blank" rel="noreferrer">
              Get Solflare <ArrowUpRight size={16} />
            </a>
            <a href="https://backpack.app/" target="_blank" rel="noreferrer">
              Get Backpack <ArrowUpRight size={16} />
            </a>
          </div>
        </details>
        <p className="nm-wallet-assurance">
          <ShieldCheck size={16} />
          Connecting does not authorize a transaction.
        </p>
        <details className="nm-wallet-dev">
          <summary>Developer options</summary>
          <p>
            A temporary browser wallet for valueless Devnet assets. Never send
            real funds to it.
          </p>
          <Button
            variant="outline"
            disabled={wallet.busy || !!busy}
            onClick={() => {
              if (address) disconnect();
              useTestWallet();
              setWalletOpen(false);
            }}
          >
            <FlaskConical size={16} />
            Use test wallet
          </Button>
        </details>
      </DialogContent>
    </Dialog>
  );
}
