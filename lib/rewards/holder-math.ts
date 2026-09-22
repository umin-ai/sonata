export type Holding = { owner: string; amount: string };
/** Aggregate wallet accounts before rounding; distribute every atom deterministically. */
export function holderShares(
  accounts: Holding[],
  budget: bigint,
  excluded: Set<string>,
) {
  if (budget <= 0n) throw Error("Waiting for new fee revenue.");
  const balances = new Map<string, bigint>();
  for (const a of accounts) {
    const value = BigInt(a.amount);
    if (value < 0n) throw Error("Invalid holder balance.");
    if (value && !excluded.has(a.owner))
      balances.set(a.owner, (balances.get(a.owner) ?? 0n) + value);
  }
  const total = [...balances.values()].reduce((a, b) => a + b, 0n);
  if (!total) throw Error("No eligible wallet holders yet.");
  const rows = [...balances].map(([recipient, balance]) => ({
    recipient,
    balance,
    amount: (budget * balance) / total,
    remainder: (budget * balance) % total,
  }));
  rows.sort((a, b) =>
    a.remainder === b.remainder
      ? a.recipient < b.recipient
        ? -1
        : 1
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  let left = budget - rows.reduce((a, b) => a + b.amount, 0n);
  for (const row of rows)
    if (left > 0n) {
      row.amount++;
      left--;
    }
  return rows
    .sort((a, b) => (a.recipient < b.recipient ? -1 : 1))
    .map((r) => ({
      recipient: r.recipient,
      amount: r.amount.toString(),
      balance: r.balance.toString(),
    }));
}
export function rewardBudget(
  retained: bigint,
  checkpoint: bigint,
  available: bigint,
  bps: number,
) {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000 || retained < checkpoint)
    throw Error("Invalid reward policy accounting.");
  const budget = ((retained - checkpoint) * BigInt(bps)) / 10000n;
  if (budget > available)
    throw Error(
      "The reserve was spent elsewhere. Update the policy to start from new fees.",
    );
  return budget;
}
