// "split": the creator share goes to up to five fixed wallets by weight, named
// in the token's metadata ("sonata": { "feeModel": "split", "split": [{ "wallet",
// "weight" }] }). A split that fails validation pays nobody: its funds stay
// owed, so a bad profile can never pay the wrong people.
import { CRANK_KEY, KNOWN_PROGRAMS, SONATA_VAULT, VAULT_ADMIN, keySet, onCurve, parseKey } from "./common.mjs";

export const MAX_SPLIT_WALLETS = 5;
export const MAX_SPLIT_WEIGHT = 100;

/**
 * { ok: true, recipients: [{ wallet: PublicKey, weight }] } or { ok: false, reason }.
 * 1-5 entries of { wallet, weight }: canonical base58 on-curve wallets, no
 * duplicates, none of `excluded` (the crank key, the Vault, its admin) or a
 * known program, integer weights 1..100.
 */
export function validateSplit(entries, { excluded = [] } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!Array.isArray(entries)) return fail("split is not a list");
  if (entries.length < 1 || entries.length > MAX_SPLIT_WALLETS) return fail(`split needs 1 to ${MAX_SPLIT_WALLETS} wallets`);
  const banned = keySet([CRANK_KEY, SONATA_VAULT, VAULT_ADMIN, ...KNOWN_PROGRAMS, ...excluded]);
  const seen = new Set();
  const recipients = [];
  for (const [i, e] of entries.entries()) {
    const at = `split[${i}]`;
    if (e === null || typeof e !== "object" || Array.isArray(e)) return fail(`${at} is not an object`);
    const wallet = parseKey(e.wallet);
    if (!wallet) return fail(`${at}.wallet is not a canonical base58 address`);
    if (!onCurve(wallet)) return fail(`${at}.wallet is not a wallet address (off curve)`);
    if (banned.has(wallet.toBase58())) return fail(`${at}.wallet is a Sonata or program address`);
    if (seen.has(wallet.toBase58())) return fail(`${at}.wallet is listed twice`);
    seen.add(wallet.toBase58());
    if (!Number.isInteger(e.weight) || e.weight < 1 || e.weight > MAX_SPLIT_WEIGHT)
      return fail(`${at}.weight must be a whole number from 1 to ${MAX_SPLIT_WEIGHT}`);
    recipients.push({ wallet, weight: e.weight });
  }
  return { ok: true, recipients };
}

/** owed * weight / total weight each, rounded down; dust stays owed. Zero shares dropped. */
export function splitShares(recipients, owed) {
  const total = recipients.reduce((s, r) => s + BigInt(r.weight), 0n);
  if (owed <= 0n || total <= 0n) return [];
  return recipients
    .map((r) => ({ owner: r.wallet, weight: r.weight, amount: (owed * BigInt(r.weight)) / total }))
    .filter((s) => s.amount > 0n);
}

/** Pays the split's wallets, creating their quote-token accounts when missing. */
export async function runSplit(ctx) {
  const { model, excludedOwners, fetchAll, owed } = ctx;
  const v = validateSplit(model.config?.split, { excluded: excludedOwners });
  if (!v.ok) return { skip: `invalid split: ${v.reason}; nothing paid, funds stay owed` };
  // A program's account is executable: never pay one, whatever its address.
  const infos = await fetchAll(v.recipients.map((r) => r.wallet));
  const program = v.recipients.find((_, i) => infos[i]?.executable);
  if (program) return { skip: `invalid split: ${program.wallet.toBase58()} is a program; nothing paid, funds stay owed` };
  const shares = splitShares(v.recipients, owed);
  ctx.fields.wallets = v.recipients.length;
  await ctx.payShares(shares, {
    module: "split",
    createMissing: true,
    detailOf: (batch) => ({ recipients: batch.map((i) => ({ wallet: i.payout.owner, weight: i.payout.weight, amount: i.payout.amount })) }),
  });
  return {};
}

/** The split's recipients with what each has been paid, for the API. */
export function splitRecipients(config, paidByWallet) {
  const v = validateSplit(config?.split);
  if (!v.ok) return { recipients: [], splitError: v.reason };
  return {
    recipients: v.recipients.map((r) => ({
      wallet: r.wallet.toBase58(),
      weight: r.weight,
      paid: paidByWallet.get(r.wallet.toBase58()) ?? "0",
    })),
  };
}
