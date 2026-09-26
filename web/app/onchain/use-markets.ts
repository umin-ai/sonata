"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { stableOrder, type HomeSnapshot, type SnapshotEntry } from "@/lib/treasury/market-snapshot";
import { fetchSnapshot, listFromSnapshot, mountPlan, readLive, type MarketList } from "./markets-client";
import { useLive } from "./live-context";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
// Registered markets exist but none could be verified: an error, not "Make the first move".
export const NOTHING_VERIFIED = "No registered market could be verified right now.";
const fromServer = async () => listFromSnapshot(await fetchSnapshot());

/**
 * The market list and every card's numbers. With the server's snapshot
 * (`initial`) the list is complete from the first render and nothing is read
 * on mount unless it is stale (mountPlan): over 15 s old it is replaced
 * quietly, from fresh server data or else the chain, and over 60 s old a
 * failed replacement shows the error alert. Without it, fresh server data or
 * the chain behind today's skeletons. After a confirmed transaction the
 * browser reads the chain quietly; Refresh reads the chain (else the server)
 * with the spinner. Any other quiet read that fails keeps the list shown.
 */
export function useMarkets(initial?: HomeSnapshot | null) {
  const { revision } = useLive();
  const [list, setList] = useState<SnapshotEntry[]>(() => initial?.entries ?? []);
  const [error, setError] = useState(() =>
    initial && !initial.entries.length && initial.skipped.length ? NOTHING_VERIFIED : "",
  );
  // Visible loads in flight (the first one without a snapshot, and Refresh clicks).
  const [visible, setVisible] = useState(() => (initial ? 0 : 1));
  const latest = useRef(0);
  // `shown`: counts as a visible load (spinner); `alert`: a failure shows the error.
  const load = useCallback(
    async (sources: (() => Promise<MarketList>)[], { shown, alert }: { shown: boolean; alert: boolean }) => {
      const id = ++latest.current;
      let result: MarketList | null = null,
        failure: unknown = null;
      for (const source of sources) {
        try {
          result = await source();
          break;
        } catch (e) {
          failure = e;
        }
      }
      if (id === latest.current) {
        if (result) {
          const next = result;
          setList((shownList) => stableOrder(shownList, next.entries));
          setError(!next.entries.length && next.skipped ? NOTHING_VERIFIED : "");
        } else if (alert) setError(message(failure, "Markets unavailable"));
      }
      if (shown) setVisible((n) => Math.max(0, n - 1));
    },
    [],
  );
  useEffect(() => {
    // Everything load() sets happens after its first await, never during the effect.
    const plan = mountPlan(initial, performance.now());
    if (plan.load) queueMicrotask(() => void load([fromServer, readLive], plan));
  }, [initial, load]);
  useEffect(() => {
    if (revision) queueMicrotask(() => void load([readLive], { shown: false, alert: false }));
  }, [revision, load]);
  const refresh = useCallback(() => {
    setVisible((n) => n + 1);
    setError("");
    void load([readLive, fromServer], { shown: true, alert: true });
  }, [load]);
  return { list, error, loading: visible > 0, refresh };
}
