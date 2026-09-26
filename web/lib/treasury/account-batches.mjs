// How market account reads are split into getMultipleAccounts calls, shared by
// the browser's readers (runtime.ts) and the indexer's market accounts reader
// (indexer/modules/market-accounts.mjs), so the two cannot drift. Plain
// JavaScript so the indexer (Node, no build step) can import it as it is.

/** The most accounts one getMultipleAccounts call asks for. */
export const MAX_ACCOUNTS_PER_CALL = 100;

/**
 * Splits keys into calls of at most `max`: the shared keys first, then each
 * group whole, so one market's own accounts are read in one call (at one
 * slot). A key is read once: a group key an earlier call already holds (a
 * payout account two markets share, say) is not read again.
 *
 * @param {string[][]} groups
 * @param {string[]} [shared]
 * @param {number} [max]
 * @returns {string[][]}
 */
export function accountBatches(groups, shared = [], max = MAX_ACCOUNTS_PER_CALL) {
  /** @type {string[][]} */
  const batches = [];
  const seen = new Set();
  /** @type {string[]} */
  let current = [];
  /** @param {string[]} keys */
  const add = (keys) => {
    for (const k of keys)
      if (!seen.has(k)) {
        seen.add(k);
        current.push(k);
      }
  };
  add(shared);
  for (const group of groups) {
    const fresh = [...new Set(group)].filter((k) => !seen.has(k));
    if (current.length && current.length + fresh.length > max) {
      batches.push(current);
      current = [];
    }
    add(fresh);
  }
  if (current.length) batches.push(current);
  return batches;
}
