// What a market page shows and what it lets the visitor send, as pure
// functions so the rule is tested (panel-state.test.ts) rather than only
// followed by the components:
//
// - The server snapshot's numbers (`snap`) are display only. They are shown
//   until the browser's live read lands, and dropped once they are older than
//   SNAPSHOT_NUMBERS_MAX_AGE_MS or when a live read fails.
// - Numbers pushed by the live stream (or polled while it is down) are the
//   same kind of display-only numbers: they become `snap` when they are newer
//   (by slot) than both the live read and the numbers shown, and are shown
//   over the live read until they are a minute old. After a failed live read
//   nothing pushed is shown until a live read succeeds again.
// - Only the live read (`live`), which passed readTreasury's binding check
//   against the chain, enables anything that trades or moves funds.
import type { TreasurySnapshot } from "@/lib/treasury/runtime";
import type { CardData } from "@/lib/treasury/market-snapshot";

export type PanelData = {
  live: TreasurySnapshot | null;
  snap: CardData | null;
  error: string;
  /** The pushed numbers' version (newest slot of their accounts); absent for the server snapshot's. */
  snapVersion?: number;
  /** When `snap` expires, in ms on the page's clock (performance.now()). */
  snapUntil?: number;
};
export type PanelAction =
  /** A refresh started: its error, if any, is cleared. */
  | { type: "reading" }
  /** The binding check passed. `partial`: a graduated market's pool fees are still to come. */
  | { type: "verified"; value: TreasurySnapshot; partial: boolean }
  /** The full live read, pool fees included. */
  | { type: "complete"; value: TreasurySnapshot }
  /** The live read failed: nothing stays on screen as if it were current. */
  | { type: "failed"; error: string }
  /** Numbers pushed by the live stream (display only), dated by their version, shown until `until`. */
  | { type: "pushed"; value: CardData; version: number; until: number }
  /** The snapshot's numbers reached their maximum age (`at`: now, on the page's clock; without it, unconditionally). */
  | { type: "expired"; at?: number };

export function panelInit(snap: CardData | null, until?: number): PanelData {
  return { live: null, snap, error: "", ...(snap && until !== undefined ? { snapUntil: until } : {}) };
}

// Pushed numbers newer than a live read stay over it; anything else is replaced by it.
const afterLive = (state: PanelData, live: TreasurySnapshot): Partial<PanelData> =>
  state.snap && state.snapVersion !== undefined && state.snapVersion > live.slot
    ? {}
    : { snap: null, snapVersion: undefined, snapUntil: undefined };

export function panelReducer(state: PanelData, action: PanelAction): PanelData {
  switch (action.type) {
    case "reading":
      return state.error ? { ...state, error: "" } : state;
    case "verified":
      // A graduated market's last full read stays until the new one completes.
      return { ...state, ...afterLive(state, action.value), live: action.partial ? (state.live ?? action.value) : action.value };
    case "complete":
      return { ...state, ...afterLive(state, action.value), live: action.value };
    case "failed":
      return { live: null, snap: null, error: action.error };
    case "pushed":
      if (state.error) return state;
      if (action.version <= (state.live?.slot ?? -1)) return state;
      if (state.snap && state.snapVersion !== undefined && action.version < state.snapVersion) return state;
      return { ...state, snap: action.value, snapVersion: action.version, snapUntil: action.until };
    case "expired":
      if (!state.snap) return state;
      if (action.at !== undefined && state.snapUntil !== undefined && action.at < state.snapUntil) return state;
      return { ...state, snap: null, snapVersion: undefined, snapUntil: undefined };
  }
}

/**
 * What the page renders from: `shown` (the header numbers: pushed numbers
 * newer than the live read, with its graduated pool fees; else the live read;
 * else the snapshot's), `fees` (what the fee and backing panels get: the live
 * read once complete, a graduated market's with its pool fees; else a curve
 * market's snapshot after hydration, since their countdowns use the time
 * now), and `verified` (only true for the live read).
 */
export function panelState({
  live,
  snap,
  hydrated,
  snapVersion,
}: {
  live: TreasurySnapshot | null;
  snap: CardData | null;
  hydrated: boolean;
  snapVersion?: number;
}) {
  const feesReady = !!live && (!live.migrated || !live.dammPool || live.poolFees !== null);
  const fees: TreasurySnapshot | CardData | null = live ? (feesReady ? live : null) : hydrated && snap && !snap.migrated ? snap : null;
  const newer = !!live && !!snap && snapVersion !== undefined && snapVersion > live.slot;
  const shown: TreasurySnapshot | CardData | null = newer
    ? { ...snap!, poolFees: live!.poolFees, uncollected: live!.migrated ? live!.uncollected : snap!.uncollected }
    : (live ?? snap);
  return { shown, fees, verified: !!live };
}

/**
 * Whether pushed numbers show a change that the live read must confirm before
 * the panel can act on it: graduation, or a curve that just filled up.
 */
export function needsLiveRead(live: TreasurySnapshot | null, pushed: CardData) {
  if (!live) return false;
  const full = (d: Pick<CardData, "quoteReserve" | "migrationQuoteThreshold">) => BigInt(d.quoteReserve) >= BigInt(d.migrationQuoteThreshold);
  return (pushed.migrated && !live.migrated) || (!pushed.migrated && full(pushed) && !full(live));
}

/** Whether a fee or backing action can be sent: a wallet, nothing in progress, numbers, and those from the live read. */
export function actionsEnabled({
  address,
  busy,
  pending,
  data,
  verified,
}: {
  address?: string | null;
  busy?: unknown;
  pending?: unknown;
  data: unknown;
  verified: boolean;
}) {
  return !!address && !busy && !pending && !!data && verified;
}

/**
 * When a snapshot's numbers expire, in ms on the page's clock
 * (performance.now()): `ageMs` is their age when the page was rendered.
 */
export const snapshotDeadline = (ageMs: number, maxAgeMs: number) => maxAgeMs - ageMs;
