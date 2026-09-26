"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { mergeList, type HomeSnapshot, type SnapshotEntry } from "@/lib/treasury/market-snapshot";
import { applyMarketEvent, removeMarket } from "@/lib/live-events";
import { fetchSnapshot, listFromSnapshot, mountPlan, readLive, type MarketList } from "./markets-client";
import { useLive } from "./live-context";
import { useLiveEvent, useStreamStatus, type LiveStream } from "./live-stream";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
// Registered markets exist but none could be verified: an error, not "Make the first move".
export const NOTHING_VERIFIED = "No registered market could be verified right now.";
const fromServer = async () => listFromSnapshot(await fetchSnapshot());
/** While the live stream is down, the list is refreshed from the server this often (±3 s), in a visible tab. */
export const FALLBACK_POLL_MS = 15_000;

/**
 * The market list and every card's numbers. With the server's snapshot
 * (`initial`) the list is complete from the first render. With its live
 * stream (`live`) the list then changes in place: a new market appears in
 * newest-first order, and a card's numbers change without it moving or
 * re-rendering the others. Nothing is read on mount unless the snapshot is
 * stale (mountPlan), stream or not (a stream whose indexer cannot read the
 * chain has nothing to send): over 15 s old it is replaced quietly,
 * from fresh server data or else the chain, and over 60 s old a failed
 * replacement shows the error alert. Without a snapshot, fresh server data or
 * the chain behind today's skeletons. While the stream is down (fallback) the
 * list is refreshed from the server every 15 s. After a confirmed transaction
 * the browser reads the chain quietly; Refresh reads the chain (else the
 * server) with the spinner. Every refresh merges by entry (mergeList): numbers
 * never go back and no card disappears because one read missed it. Any other
 * quiet read that fails keeps the list shown.
 */
export function useMarkets(initial?: HomeSnapshot | null, live: LiveStream | null = null) {
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
          setList((shownList) => mergeList(shownList, next.entries));
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

  useLiveEvent(live, "market", (ev) => setList((l) => applyMarketEvent(l, ev)));
  useLiveEvent(live, "removed", (ev) => setList((l) => removeMarket(l, ev.pool)));
  useLiveEvent(live, "snapshot", (snap) => {
    if (snap.scope === "list") {
      setList((l) => mergeList(l, snap.entries));
      if (snap.entries.length) setError("");
    }
  });
  const status = useStreamStatus(live);
  useEffect(() => {
    if (status !== "fallback") return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(
        () => {
          if (document.visibilityState === "visible") void load([fromServer], { shown: false, alert: false });
          next();
        },
        FALLBACK_POLL_MS + (Math.random() - 0.5) * 6_000,
      );
    };
    next();
    return () => clearTimeout(timer);
  }, [status, load]);

  const refresh = useCallback(() => {
    setVisible((n) => n + 1);
    setError("");
    void load([readLive, fromServer], { shown: true, alert: true });
  }, [load]);
  return { list, error, loading: visible > 0, refresh };
}
