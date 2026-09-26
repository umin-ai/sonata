// "split": the creator share goes to up to five fixed wallets by weight, named
// in the token's metadata ("sonata": { "feeModel": "split", "split": [{ "wallet",
// "weight" }] }). A split that fails validation pays nobody: its funds stay
// owed, so a bad profile can never pay the wrong people. The rules are shared
// with the app (lib/split-rules.mjs).
//
// Payouts go by allocation rounds (payout.mjs payAllocated): each wallet's
// share of a round stays that wallet's until it is paid, so a wallet that
// cannot receive for a while (memo required, account closed) is paid later
// and never loses its share to the others. The crank creates a wallet's quote
// account at most once per market (the ledger remembers it); if the wallet
// closes it, its shares wait until the wallet opens it again.
import { validateSplit } from "../../lib/split-rules.mjs";
import { payAllocated } from "./payout.mjs";

export { MAX_SPLIT_WALLETS, MAX_SPLIT_WEIGHT, SPLIT_BLOCKED_KEYS, validateSplit } from "../../lib/split-rules.mjs";

/** owed * weight / total weight each, rounded down; dust stays owed. Zero shares dropped. */
export function splitShares(recipients, owed) {
  const total = recipients.reduce((s, r) => s + BigInt(r.weight), 0n);
  if (owed <= 0n || total <= 0n) return [];
  return recipients
    .map((r) => ({ owner: r.wallet, weight: r.weight, amount: (owed * BigInt(r.weight)) / total }))
    .filter((s) => s.amount > 0n);
}

/** Pays the split's wallets, creating each one's quote-token account at most once. */
export async function runSplit(ctx) {
  const { model, excludedOwners, fetchAll, ledger, line } = ctx;
  const v = validateSplit(model.config?.split, { excluded: excludedOwners });
  if (!v.ok) return { skip: `invalid split: ${v.reason}; nothing paid, funds stay owed` };
  // A program's account is executable: never pay one, whatever its address.
  const infos = await fetchAll(v.recipients.map((r) => r.wallet));
  const program = v.recipients.find((_, i) => infos[i]?.executable);
  if (program) return { skip: `invalid split: ${program.wallet.toBase58()} is a program; nothing paid, funds stay owed` };
  ctx.fields.wallets = v.recipients.length;
  const weights = new Map(v.recipients.map((r) => [r.wallet.toBase58(), r.weight]));
  const created = await ledger.createdAccounts(line.pool);
  await payAllocated(ctx, {
    module: "split",
    allocate: async (amount) => splitShares(v.recipients, amount),
    create: (owner) => !created.has(owner.toBase58()),
    detailOf: (batch) => ({
      recipients: batch.map((i) => ({ wallet: i.payout.owner, weight: weights.get(i.payout.owner.toBase58()), amount: i.payout.amount })),
    }),
  });
  return {};
}

/**
 * The split's recipients with what each has been paid, for the API. It
 * applies the bot's own rules (validateSplit, with `excluded` for the keys the
 * bot adds at run time), so it never lists a wallet the bot would refuse.
 */
export function splitRecipients(config, paidByWallet, { excluded = [] } = {}) {
  const v = validateSplit(config?.split, { excluded });
  if (!v.ok) return { recipients: [], splitError: v.reason };
  return {
    recipients: v.recipients.map((r) => ({
      wallet: r.wallet.toBase58(),
      weight: r.weight,
      paid: paidByWallet.get(r.wallet.toBase58()) ?? "0",
    })),
  };
}
