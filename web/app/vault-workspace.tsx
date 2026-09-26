"use client";
import { useEffect, useState, useRef, type ReactNode } from "react";
import { StockroomShell } from "./stockroom-shell";
import { toast } from "sonner";
import { usePathname } from "next/navigation";
import {
  initialDemo,
  hydrateDemo,
  transition,
  type Demo,
  type Action,
} from "@/lib/vaults/demo";
import { DemoContext as Context } from "./vault-state";
export function AppProvider({ children }: { children: ReactNode }) {
  return <VaultProvider>{children}</VaultProvider>;
}
function VaultProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Demo>(initialDemo);
  const stateRef = useRef(state);
  const [ready, setReady] = useState(false),
    [hasBackup, setHasBackup] = useState(false);
  const path = usePathname();
  const firstPath = useRef(true);
  useEffect(() => {
    // A client-side route change starts at the top. The first render does not:
    // pages arrive with their content, and a reader who scrolled before the
    // scripts finished loading keeps their place.
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    if (!window.location.hash) window.scrollTo({ top: 0, behavior: "instant" });
  }, [path]);
  useEffect(() => {
    let cancelled = false;
    // Load browser-owned state after hydration; actions remain disabled until ready.
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        setHasBackup(!!localStorage.getItem("stockroom-vault-demo-backup"));
        const raw = localStorage.getItem("stockroom-vault-demo-v1");
        if (raw) {
          const saved = hydrateDemo(JSON.parse(raw));
          stateRef.current = saved;
          setState(saved);
        }
      } catch {}
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (ready)
      try {
        localStorage.setItem("stockroom-vault-demo-v1", JSON.stringify(state));
      } catch {
        toast.error(
          "Browser storage unavailable; this session will not be saved.",
        );
      }
  }, [state, ready]);
  const act = (a: Action) => {
    if (!ready) throw new Error("Your saved demo is still loading.");
    const next = transition(
      stateRef.current,
      a,
      crypto.randomUUID(),
      new Date().toISOString(),
    );
    stateRef.current = next;
    setState(next);
    toast.success(`${next.entries[0].type} complete`, {
      description: "Local simulation · no real funds moved",
    });
  };
  const reset = () => {
    try {
      localStorage.setItem(
        "stockroom-vault-demo-backup",
        JSON.stringify(stateRef.current),
      );
      setHasBackup(true);
    } catch {
      toast.error("Could not save backup. Existing session kept.");
      return;
    }
    const fresh = initialDemo();
    stateRef.current = fresh;
    setState(fresh);
    toast.success("Fresh demo started. Previous session can be restored.");
  };
  const restore = () => {
    try {
      const raw = localStorage.getItem("stockroom-vault-demo-backup");
      if (raw) {
        const old = hydrateDemo(JSON.parse(raw));
        stateRef.current = old;
        setState(old);
        toast.success("Previous demo restored.");
      }
    } catch {
      toast.error("Previous demo could not be read.");
    }
  };
  return (
    <Context.Provider value={{ state, act, ready }}>
      <StockroomShell reset={reset} restore={restore} hasBackup={hasBackup}>
        {children}
      </StockroomShell>
    </Context.Provider>
  );
}
