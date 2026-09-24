"use client";
import { useEffect, useRef, useState } from "react";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsFeature,
} from "@wallet-standard/features";

export function useWallet(
  chain: "solana:mainnet" | "solana:devnet" = "solana:mainnet",
  requireSigning = false,
) {
  const [wallets, setWallets] = useState<readonly Wallet[]>([]),
    [wallet, setWallet] = useState<Wallet | null>(null),
    [account, setAccount] = useState<WalletAccount | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const attempt = useRef(0),
    restored = useRef(false);
  // Links are full page loads, so the chosen wallet is remembered per chain and
  // reconnected silently: only a wallet that has already approved this site
  // answers a silent connect, so this never opens a prompt.
  const storageKey = `sonata.wallet.${chain}`;
  const remember = (name: string | null) => {
    try {
      if (name) localStorage.setItem(storageKey, name);
      else localStorage.removeItem(storageKey);
    } catch {}
  };
  useEffect(() => {
    if (restored.current || wallet || !wallets.length) return;
    let name: string | null = null;
    try {
      name = localStorage.getItem(storageKey);
    } catch {}
    const saved = name ? wallets.find((w) => w.name === name) : undefined;
    if (!saved) return;
    restored.current = true;
    const id = ++attempt.current;
    const f = saved.features as unknown as StandardConnectFeature;
    void f["standard:connect"]
      .connect({ silent: true })
      .then((result) => {
        if (id !== attempt.current) return;
        const a = result.accounts.find((a) => a.chains.includes(chain));
        if (a) {
          setWallet(saved);
          setAccount(a);
        }
      })
      .catch(() => {});
  }, [wallets, wallet, chain, storageKey]);
  useEffect(() => {
    const registry = getWallets();
    const update = () =>
      setWallets(
        registry
          .get()
          .filter(
            (w) =>
              w.chains.includes(chain) &&
              "standard:connect" in w.features &&
              (!requireSigning || "solana:signTransaction" in w.features),
          ),
      );
    update();
    const a = registry.on("register", update),
      b = registry.on("unregister", update);
    return () => {
      a();
      b();
    };
  }, [chain, requireSigning]);
  useEffect(() => {
    if (!wallet) return;
    const f = wallet.features as unknown as Partial<StandardEventsFeature>;
    return f["standard:events"]?.on("change", (event) => {
      if (event.accounts)
        setAccount(
          event.accounts.find((a) => a.chains.includes(chain)) ?? null,
        );
    });
  }, [wallet, chain]);
  const connect = async (selected: Wallet) => {
    const id = ++attempt.current;
    setBusy(true);
    setError("");
    try {
      const f = selected.features as unknown as StandardConnectFeature;
      const result = await f["standard:connect"].connect();
      if (id !== attempt.current) return false;
      const a = result.accounts.find((a) => a.chains.includes(chain));
      if (!a)
        throw new Error(
          `Select a Solana ${chain === "solana:devnet" ? "Devnet" : "mainnet"} account in your wallet.`,
        );
      setWallet(selected);
      setAccount(a);
      remember(selected.name);
      return true;
    } catch (e) {
      if (id === attempt.current)
        setError(e instanceof Error ? e.message : "Connection declined");
      return false;
    } finally {
      if (id === attempt.current) setBusy(false);
    }
  };
  const disconnect = async () => {
    attempt.current++;
    setBusy(false);
    const previous = wallet;
    setWallet(null);
    setAccount(null);
    setError("");
    remember(null);
    try {
      const f =
        previous?.features as unknown as Partial<StandardDisconnectFeature>;
      await f?.["standard:disconnect"]?.disconnect();
    } catch {}
  };
  return { wallets, wallet, account, busy, error, connect, disconnect };
}
