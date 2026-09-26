// What a market page shows and what it lets the visitor send, as pure
// functions so the rule is tested (panel-state.test.ts) rather than only
// followed by the components:
//
// - The server snapshot's numbers (`snap`) are display only. They are shown
//   until the browser's live read lands, and dropped once they are older than
//   SNAPSHOT_NUMBERS_MAX_AGE_MS or when a live read fails.
// - Numbers pushed by the live stream (or polled while it is down) are the
//   same kind of display-only numbers: they become `snap` when they are newer
//   (by version: the newest slot of their accounts) than both the live read
//   and the numbers shown, and are shown over the live read. While the stream
//   is live they do not age (it pushes every change, so silence means no
//   change); once it stops they age from then, and while it is down the
//   market's numbers are polled instead. After a failed live read nothing
//   pushed is shown until a live read succeeds again.
// - Numbers are never replaced by older ones: when numbers newer than the
//   live read reach their age, they stay until a new live read (which the
//   page starts then) replaces them.
// - Only the live read (`live`), which passed readTreasury's binding check
//   against the chain, enables anything that trades or moves funds.
import type { TreasurySnapshot } from "@/lib/treasury/runtime";
import type { CardData } from "@/lib/treasury/market-snapshot";

export type PanelData = {
  live: TreasurySnapshot | null;
  snap: CardData | null;
  error: string;
  /** The numbers' version (the newest slot of their accounts), when known. */
  snapVersion?: number;
  /**
   * When `snap` expires, in ms on the page's clock (performance.now()):
   * Infinity while the live stream is live; absent when it does not expire
   * (numbers newer than the live read, kept until a live read replaces them).
   */
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
  /** Numbers pushed by the live stream (display only), dated by their version, shown until `until` (Infinity: while the stream is live). */
  | { type: "pushed"; value: CardData; version: number; until: number }
  /** The live stream stopped: numbers it pushed start to age, and expire at `until`. */
  | { type: "renew"; until: number }
  /** The numbers reached their maximum age (`at`: now, on the page's clock; without it, unconditionally). */
  | { type: "expired"; at?: number };

/** The page's first state: the server snapshot's numbers (or a pushed entry's), expiring at `until`, dated by `version`. */
export function panelInit(snap: CardData | null, until?: number, version?: number): PanelData {
  return {
    live: null,
    snap,
    error: "",
    ...(snap && until !== undefined ? { snapUntil: until } : {}),
    ...(snap && version !== undefined ? { snapVersion: version } : {}),
  };
}

/** Whether the numbers shown are newer than the live read: they then stay when they expire, until a new live read. */
export const newerThanLive = (state: Pick<PanelData, "live" | "snap" | "snapVersion">) =>
  !!state.live && !!state.snap && state.snapVersion !== undefined && state.snapVersion > state.live.slot;

/** Whether `snapUntil` is a moment to expire at (not Infinity: the stream is live; not absent: kept). */
export const expiresAt = (state: Pick<PanelData, "snap" | "snapUntil">) =>
  state.snap && state.snapUntil !== undefined && Number.isFinite(state.snapUntil) ? state.snapUntil : null;

// Numbers newer than a live read stay over it; anything else is replaced by it.
const afterLive = (state: PanelData, live: TreasurySnapshot): Partial<PanelData> =>
  newerThanLive({ ...state, live }) ? {} : { snap: null, snapVersion: undefined, snapUntil: undefined };

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
    case "renew":
      return state.snap && state.snapUntil === Infinity ? { ...state, snapUntil: action.until } : state;
    case "expired": {
      if (!state.snap) return state;
      const at = expiresAt(state);
      if (action.at !== undefined && (at === null || action.at < at)) return state;
      // Newer than the live read: kept (the page reads again) rather than going back to older numbers.
      if (newerThanLive(state)) return state.snapUntil === undefined ? state : { ...state, snapUntil: undefined };
      return { ...state, snap: null, snapVersion: undefined, snapUntil: undefined };
    }
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
  const newer = newerThanLive({ live, snap, snapVersion });
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
