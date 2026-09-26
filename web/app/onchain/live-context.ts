"use client";
import { createContext, useContext } from "react";
import type { useWallet } from "@/hooks/use-wallet";
import type { PreparedTreasury } from "@/lib/treasury/runtime";
export type Pending = {
  signature: string;
  lastValidBlockHeight: number;
  action?: PreparedTreasury["action"];
  wallet: string;
};
type LiveValue = {
  wallet: ReturnType<typeof useWallet>;
  address: string;
  busy: string;
  pending: Pending | null;
  error: string;
  revision: number;
  labels: Record<string, string>;
  execute: (build: () => Promise<PreparedTreasury>, options?: { direct?: boolean }) => Promise<void>;
  useTestWallet: () => void;
  walletOpen: boolean;
  setWalletOpen: (open: boolean) => void;
  connectWallet: (
    selected: ReturnType<typeof useWallet>["wallets"][number],
  ) => Promise<boolean>;
  disconnect: () => void;
};
export const LiveContext = createContext<LiveValue | null>(null);
export function useLive() {
  const value = useContext(LiveContext);
  if (!value) throw Error("Missing Sonata wallet provider");
  return value;
}
