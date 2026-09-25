// Sonata's payout bot: when it runs, and whether it will pick a market up.
// Its timer fires on the quarter hour (deploy/lightsail/sonata-crank.timer,
// OnCalendar=*:0/15) and a pass reaches each market within a few minutes. It
// collects a market's fees once at least BOT_MIN_ATOMS are waiting
// (indexer/crank.mjs DEFAULT_MIN_ATOMS) and pays out anything already
// collected on every run.
export const QUARTER_MS = 15 * 60_000;
export const PASS_MS = 4 * 60_000;
export const BOT_MIN_ATOMS = 10_000n;

export type PayoutClock =
  /** The bot is on its way round the markets now. */
  | { state: "running" }
  /** Milliseconds to the next run. */
  | { state: "waiting"; msLeft: number };

export function payoutClock(now: number): PayoutClock {
  const into = now % QUARTER_MS;
  return into < PASS_MS ? { state: "running" } : { state: "waiting", msLeft: QUARTER_MS - into };
}

/** "07:42" */
export function mmss(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * What the next run does with a market's fees: "pays" them, "waits" for more
 * (too little to collect), or "none" (nothing there); and "late" when fees
 * the bot should have taken are still waiting well after a run.
 */
export function nextPayout({
  uncollected,
  unallocated,
  lastClaimTs,
  now,
}: {
  uncollected: bigint;
  unallocated: bigint;
  lastClaimTs: number;
  now: number;
}) {
  const due = uncollected >= BOT_MIN_ATOMS || unallocated > 0n;
  const kind = due ? "pays" : uncollected > 0n ? "waits" : "none";
  // Due fees still there more than a full cycle after the last collection.
  const late = due && now - lastClaimTs * 1000 > QUARTER_MS + PASS_MS && payoutClock(now).state === "waiting";
  return { kind, late } as const;
}
