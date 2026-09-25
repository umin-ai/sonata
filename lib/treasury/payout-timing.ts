// When Sonata's payout bot last collected a market's fees and when it runs
// next, as short text. The bot's timer fires on the quarter hour (:00, :15,
// :30, :45; deploy/lightsail/sonata-crank.timer), and a pass can take a few
// minutes to reach each market, so "next" is approximate.

/** "just now", "3 min ago", "2 h ago" from a unix time in seconds, measured at `now` (ms). */
export function sinceText(seconds: number, now: number) {
  const mins = Math.max(0, Math.round((now / 1000 - seconds) / 60));
  return mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
}

/** "in ~7 min" until the next quarter hour after `now` (ms). */
export function nextRunText(now: number) {
  const mins = 15 - (new Date(now).getMinutes() % 15);
  return mins <= 1 ? "in ~1 min" : `in ~${mins} min`;
}
