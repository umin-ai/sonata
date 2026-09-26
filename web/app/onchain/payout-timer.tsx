"use client";
import { useEffect, useState } from "react";
import { mmss, nextPayout, payoutClock } from "@/lib/treasury/payout-clock";

/** The current time, ticking once a second while mounted. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** "07:42", or "now" while the bot is going round the markets. */
export function countdown(now: number) {
  const c = payoutClock(now);
  return c.state === "running" ? "now" : mmss(c.msLeft);
}

type Fees = { uncollected: bigint; unallocated: bigint; lastClaimTs: number };

/**
 * The next automatic payout, counting down, in place of a button: fees are
 * paid by Sonata's bot and there is nothing to claim. Only if the bot is
 * overdue does a small link let anyone send them (the permissionless
 * fallback, which pays the split, not whoever presses it).
 */
export function PayoutTimer({ fees, stock, onSend, sendDisabled }: { fees: Fees; stock: string; onSend: () => void; sendDisabled?: boolean }) {
  const now = useNow();
  const c = payoutClock(now);
  const next = nextPayout({ ...fees, now });
  return (
    <div className="payout-timer" role="timer" aria-live="off">
      <span>Next payout</span>
      <strong>{c.state === "running" ? "Paying out now" : mmss(c.msLeft)}</strong>
      <small>
        {next.kind === "pays"
          ? "By Sonata's bot · nothing to claim"
          : next.kind === "waits"
            ? `Waits until at least 0.0001 ${stock} has built up`
            : "Nothing waiting yet · nothing to claim"}
      </small>
      {next.late && (
        <button type="button" className="sr-text-link" disabled={sendDisabled} onClick={onSend}>
          Bot running late? Send it now
        </button>
      )}
    </div>
  );
}

/**
 * The same, as a short line for rows: "in 07:42" or "now" when the next run
 * pays these fees, "once more builds up" when they are under the bot's
 * minimum, plus whether the bot is overdue.
 */
export function usePayoutLine(fees: Fees | null) {
  const now = useNow();
  if (!fees) return { text: "", late: false, when: "" };
  const next = nextPayout({ ...fees, now });
  const when = countdown(now) === "now" ? "now" : `in ${countdown(now)}`;
  return { text: next.kind === "waits" ? "once more builds up" : when, late: next.late, when };
}
