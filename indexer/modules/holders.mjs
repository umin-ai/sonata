// The holder rules shared by the holders, lpFarm (on the curve) and diamond
// modules and the graduation airdrop, and the "holders" module itself.
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import { CRANK_KEY, SONATA_VAULT, VAULT_ADMIN } from "./common.mjs";
import { payAllocated, rewardShares } from "./payout.mjs";

export const MAX_RECIPIENTS = 200;
// A holder needs at least supply / MIN_HOLDING_DIVISOR (0.01% of supply).
export const MIN_HOLDING_DIVISOR = 10_000n;
const TOKEN_ACCOUNT_SIZE = 165;

/**
 * The holders to pay, from a getProgramAccounts snapshot of the base mint's
 * classic SPL token accounts: balances summed per owner wallet, excluding the
 * given token accounts (the DBC base vault, the treasury's base account) and
 * owners (the crank key it runs with, the Vault admin it read), Sonata's own
 * keys (the payout bot, the Vault, its admin) whatever the caller passes,
 * owners off the ed25519 curve (PDAs: pool authorities, DAMM v2 pools,
 * program vaults) and holders of less than 0.01% of supply. Largest first
 * (ties by address), at most `max`.
 */
export function selectHolders(accounts, { mint, supply, excludedAccounts = [], excludedOwners = [], max = MAX_RECIPIENTS }) {
  const skipAccounts = new Set(excludedAccounts.filter(Boolean).map((k) => k.toBase58()));
  const skipOwners = new Set([CRANK_KEY, SONATA_VAULT, VAULT_ADMIN, ...excludedOwners].filter(Boolean).map((k) => k.toBase58()));
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

/**
 * A reward market's holders now (see selectHolders), read from the chain:
 * the crank key, ctx.excludedOwners (the Vault admin, the Vault) and Sonata's
 * own keys are never among them.
 */
export async function listHolders(ctx) {
  const { m, get, rpc, connection, authority, excludedOwners = [] } = ctx;
  if (!m.baseVault) throw Error("DBC pool not verified this pass; base vault unknown");
  const supply = unpackMint(m.baseMint, get(m.baseMint), TOKEN_PROGRAM_ID).supply;
  const listed = await rpc(() =>
    connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [{ dataSize: TOKEN_ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: m.baseMint.toBase58() } }],
    }),
  );
  return selectHolders(listed, {
    mint: m.baseMint,
    supply,
    excludedAccounts: [m.baseVault, m.treasuryBase],
    excludedOwners: [authority.publicKey, ...excludedOwners],
  });
}

/**
 * "holders": owed pro rata to the base token's holders, each to an existing
 * quote account, by allocation rounds (payout.mjs payAllocated): a holder's
 * share of a round stays theirs until it is paid. lpFarm uses it on the
 * curve (with `resolve` for its position rows); diamond passes the `holders`
 * it has already read and `weigh` to scale each holder's balance before the
 * round is split.
 */
export async function payHolders(ctx, { module = "holders", detail = null, weigh = null, holders = null, resolve = null } = {}) {
  const { result } = ctx;
  result.holders = holders?.length ?? 0;
  result.payable = 0;
  const detailOf = () => (typeof detail === "function" ? detail() : detail);
  await payAllocated(ctx, {
    module,
    detailOf,
    resolve,
    emptyNote: "no payable holders",
    allocate: async (amount) => {
      const list = holders ?? (await listHolders(ctx));
      result.holders = list.length;
      return rewardShares(weigh ? await weigh(list) : list, amount);
    },
  });
  return {};
}
