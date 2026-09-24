// The rules a fee-model split must pass, shared by Sonata's payout bot
// (indexer/modules/split.mjs) and the app, so a split the launch form accepts
// is one the bot will pay. The bot also refuses a wallet whose account is
// executable, which needs the chain (an RPC read), so it is not checked here.
// The program list has one source, indexer/modules/common.mjs KNOWN_PROGRAMS.
import { CRANK_KEY, KNOWN_PROGRAMS, SONATA_VAULT, VAULT_ADMIN, onCurve, parseKey } from "../indexer/modules/common.mjs";

export const MAX_SPLIT_WALLETS = 5;
export const MAX_SPLIT_WEIGHT = 100;

// Never a split recipient (base58): Sonata's payout bot, the Vault and its
// admin, and every known program id (program ids are on the ed25519 curve, so
// the wallet check alone does not catch them).
export const SPLIT_BLOCKED_KEYS = Object.freeze([...new Set([CRANK_KEY, SONATA_VAULT, VAULT_ADMIN, ...KNOWN_PROGRAMS].map((k) => k.toBase58()))]);

/**
 * { ok: true, recipients: [{ wallet: PublicKey, weight }] } or { ok: false, reason }.
 * 1-5 entries of { wallet, weight }: canonical base58 on-curve wallets, no
 * duplicates, none of SPLIT_BLOCKED_KEYS or `excluded` (the bot adds the key it
 * runs with and the Vault admin it reads), integer weights 1..100.
 */
export function validateSplit(entries, { excluded = [] } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!Array.isArray(entries)) return fail("split is not a list");
  if (entries.length < 1 || entries.length > MAX_SPLIT_WALLETS) return fail(`split needs 1 to ${MAX_SPLIT_WALLETS} wallets`);
  const banned = new Set([...SPLIT_BLOCKED_KEYS, ...excluded.filter(Boolean).map((k) => (typeof k === "string" ? k : k.toBase58()))]);
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
