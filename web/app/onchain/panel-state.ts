// What a market page shows and what it lets the visitor send, as pure
// functions so the rule is tested (panel-state.test.ts) rather than only
// followed by the components:
//
// - The server snapshot's numbers (`snap`) are display only. They are shown
//   until the browser's live read lands, and dropped once they are older than
//   SNAPSHOT_NUMBERS_MAX_AGE_MS or when a live read fails.
// - Only the live read (`live`), which passed readTreasury's binding check
//   against the chain, enables anything that trades or moves funds.
import type { TreasurySnapshot } from "@/lib/treasury/runtime";
import type { CardData } from "@/lib/treasury/market-snapshot";

export type PanelData = { live: TreasurySnapshot | null; snap: CardData | null; error: string };
export type PanelAction =
  /** A refresh started: its error, if any, is cleared. */
  | { type: "reading" }
  /** The binding check passed. `partial`: a graduated market's pool fees are still to come. */
  | { type: "verified"; value: TreasurySnapshot; partial: boolean }
  /** The full live read, pool fees included. */
  | { type: "complete"; value: TreasurySnapshot }
  /** The live read failed: nothing stays on screen as if it were current. */
  | { type: "failed"; error: string }
  /** The snapshot's numbers reached their maximum age. */
  | { type: "expired" };

export function panelInit(snap: CardData | null): PanelData {
  return { live: null, snap, error: "" };
}

export function panelReducer(state: PanelData, action: PanelAction): PanelData {
  switch (action.type) {
    case "reading":
      return state.error ? { ...state, error: "" } : state;
    case "verified":
      // A graduated market's last full read stays until the new one completes.
      return { ...state, snap: null, live: action.partial ? (state.live ?? action.value) : action.value };
    case "complete":
      return { ...state, snap: null, live: action.value };
    case "failed":
      return { live: null, snap: null, error: action.error };
    case "expired":
      return state.snap ? { ...state, snap: null } : state;
  }
}

/**
 * What the page renders from: `shown` (the header numbers: live, else the
 * snapshot's), `fees` (what the fee and backing panels get: the live read
 * once complete, a graduated market's with its pool fees; else a curve
 * market's snapshot after hydration, since their countdowns use the time
 * now), and `verified` (only true for the live read).
 */
export function panelState({ live, snap, hydrated }: { live: TreasurySnapshot | null; snap: CardData | null; hydrated: boolean }) {
  const feesReady = !!live && (!live.migrated || !live.dammPool || live.poolFees !== null);
  const fees: TreasurySnapshot | CardData | null = live ? (feesReady ? live : null) : hydrated && snap && !snap.migrated ? snap : null;
  return { shown: live ?? snap, fees, verified: !!live };
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
