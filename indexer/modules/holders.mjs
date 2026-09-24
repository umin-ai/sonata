// The holder rules shared by the holders, lpFarm (on the curve) and diamond
// modules and the graduation airdrop.
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";

export const MAX_RECIPIENTS = 200;
// A holder needs at least supply / MIN_HOLDING_DIVISOR (0.01% of supply).
export const MIN_HOLDING_DIVISOR = 10_000n;

/**
 * The holders to pay, from a getProgramAccounts snapshot of the base mint's
 * classic SPL token accounts: balances summed per owner wallet, excluding the
 * given token accounts (the DBC base vault, the treasury's base account) and
 * owners (the crank key), owners off the ed25519 curve (PDAs: pool authorities,
 * DAMM v2 pools, program vaults) and holders of less than 0.01% of supply.
 * Largest first (ties by address), at most `max`.
 */
export function selectHolders(accounts, { mint, supply, excludedAccounts = [], excludedOwners = [], max = MAX_RECIPIENTS }) {
  const skipAccounts = new Set(excludedAccounts.filter(Boolean).map((k) => k.toBase58()));
  const skipOwners = new Set(excludedOwners.map((k) => k.toBase58()));
  const byOwner = new Map();
  for (const { pubkey, account } of accounts) {
    if (skipAccounts.has(pubkey.toBase58())) continue;
    let a;
    try {
      a = unpackAccount(pubkey, account, TOKEN_PROGRAM_ID);
    } catch {
      continue;
    }
    const owner = a.owner.toBase58();
    if (!a.mint.equals(mint) || !a.amount || skipOwners.has(owner) || !PublicKey.isOnCurve(a.owner.toBytes())) continue;
    const seen = byOwner.get(owner);
    // `account` is the owner's largest token account (ties by address), where an airdrop goes.
    const largest = !seen || a.amount > seen.largest || (a.amount === seen.largest && pubkey.toBase58() < seen.account.toBase58());
    byOwner.set(owner, {
      owner: a.owner,
      balance: (seen?.balance ?? 0n) + a.amount,
      account: largest ? pubkey : seen.account,
      largest: largest ? a.amount : seen.largest,
    });
  }
  if (supply <= 0n) return [];
  return [...byOwner.values()]
    .filter((h) => h.balance * MIN_HOLDING_DIVISOR >= supply)
    .sort((a, b) =>
      a.balance === b.balance
        ? (a.owner.toBase58() < b.owner.toBase58() ? -1 : 1)
        : (a.balance > b.balance ? -1 : 1),
    )
    .slice(0, max)
    .map((h) => ({ owner: h.owner, balance: h.balance, account: h.account }));
}
