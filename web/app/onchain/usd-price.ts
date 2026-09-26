"use client";
import { useEffect, useState } from "react";
import { useSnapshotPrice } from "./snapshot-context";

// USD per quote stock token from the site's price route, shared by every
// component on the page and refetched at most once a minute. Null when the
// stock has no usable price.
const prices = new Map<string, { at: number; promise: Promise<number | null> }>();
export function usdPrice(symbol: string) {
  const hit = prices.get(symbol);
  if (hit && Date.now() - hit.at < 60_000) return hit.promise;
  const promise = fetch(`/api/stock-price?symbol=${encodeURIComponent(symbol)}`)
    .then((r) => (r.ok ? (r.json() as Promise<{ price?: unknown; error?: string }>) : null))
    .then((d) => (typeof d?.price === "number" && d.price > 0 && !d.error ? d.price : null))
    .catch(() => null);
  prices.set(symbol, { at: Date.now(), promise });
  return promise;
}

/** The stock's USD price: from the server's snapshot when it has one (no fetch), else fetched as above. */
export function useUsdPrice(symbol: string) {
  const seeded = useSnapshotPrice(symbol);
  const [price, setPrice] = useState<{ symbol: string; value: number | null } | null>(() =>
    seeded !== undefined ? { symbol, value: seeded } : null,
  );
  const known = price?.symbol === symbol;
  useEffect(() => {
    if (known) return;
    let active = true;
    void usdPrice(symbol).then((value) => {
      if (active) setPrice({ symbol, value });
    });
    return () => {
      active = false;
    };
  }, [symbol, known]);
  return known ? price.value : null;
}
