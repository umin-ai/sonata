"use client";
// React access to a page's live stream (live-stream-client.ts). Each page
// makes its own store (never module state, which the server would share
// between requests), renders from its server snapshot, and opens the stream
// after mount.
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ProfileBody } from "@/lib/treasury/market-snapshot";
import type { PoolStats } from "@/lib/market-data";
import { createLiveStream, type LiveHandlers, type LiveStream, type LiveStreamOptions, type StreamStatus } from "./live-stream-client";

export type { LiveStream, StreamStatus };
const LiveStreamContext = createContext<LiveStream | null>(null);
/** Makes a page's stream available to the components below it (trades, chart, stats, the market panel). */
export const LiveStreamProvider = LiveStreamContext.Provider;
/** The page's stream, or null on pages without one. */
export const useLiveStream = () => useContext(LiveStreamContext);

/** This page's stream: made once per mount, opened after mount, closed on unmount. */
export function useLiveStreamInstance(options: LiveStreamOptions) {
  const [store] = useState(() => createLiveStream(options));
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  return store;
}

const none = () => () => {};
const NO_PROFILES: Record<string, ProfileBody | null> = Object.freeze({}) as Record<string, ProfileBody | null>;

/** "off" (no stream on this page), "connecting", "live" or "fallback" (poll instead). */
export function useStreamStatus(store: LiveStream | null): StreamStatus {
  return useSyncExternalStore(
    store ? store.subscribe : none,
    () => store?.status ?? "off",
    () => store?.initialStatus ?? "off",
  );
}

/** How many full snapshots the stream has sent: a component that loaded its own data loads it again after one. */
export function useLiveResync(store: LiveStream | null): number {
  return useSyncExternalStore(store ? store.subscribe : none, () => store?.resync ?? 0, () => 0);
}

/** Token profiles the stream carried (image and fee model; null: none to show, do not fetch). */
export function useLiveProfiles(store: LiveStream | null) {
  return useSyncExternalStore(store ? store.subscribe : none, () => store?.profiles ?? NO_PROFILES, () => NO_PROFILES);
}

/** A pool's 24h stats from the page's stream: its row, null (covered, none), or undefined (not covered: load them as before). */
export function useLivePoolStats(pool: string): PoolStats | null | undefined {
  const store = useLiveStream();
  return useSyncExternalStore(store ? store.subscribe : none, () => store?.stats(pool), () => undefined);
}

/** Calls `handler` for each event of `kind` on the page's stream, always the latest handler. */
export function useLiveEvent<K extends keyof LiveHandlers>(store: LiveStream | null, kind: K, handler: LiveHandlers[K]) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!store) return;
    const call = ((ev: never) => (latest.current as (e: never) => void)(ev)) as LiveHandlers[K];
    return store.on(kind, call);
  }, [store, kind]);
}
