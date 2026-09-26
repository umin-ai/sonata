// Constants and small helpers shared by the crank's fee modules.
import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

// Sonata's payout bot (the crank key that Reward token markets name as payout
// owner) and the Sonata Vault's admin. The crank also excludes the key it runs
// with and the admin it reads from the Vault; these are for the read-only API
// and for validating metadata before the chain is read.
export const CRANK_KEY = new PublicKey("Fb83XLPdUM11FrUUBNaB1JXJ2feJacNkcPGUzP8dtGz");
export const VAULT_ADMIN = new PublicKey("vb4pminVbRa8BRaRCDa7JmAkFx6LSmnwMiDtsKvkXVF");
export const SONATA_VAULT = new PublicKey("5XMFEnW8Ur3EswbFhCr1LEKtHDioTs8oeQEHKyPHNpp5");
export const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export const DBC_PROGRAM = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const DAMM_V2_PROGRAM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const TREASURY_PROGRAM = new PublicKey("GPANv5zMEmvkVKQxJgLds2B4bEbnub6HhS2WQq71fjNj");
// Programs a payout must never be addressed to. Program ids are ordinary
// ed25519 keys, so the on-curve check alone does not catch them; the split
// module also rejects any wallet whose account is executable.
export const KNOWN_PROGRAMS = [
  SystemProgram.programId,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  METADATA_PROGRAM,
  DBC_PROGRAM,
  DAMM_V2_PROGRAM,
  TREASURY_PROGRAM,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  new PublicKey("ComputeBudget111111111111111111111111111111"),
  new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
  new PublicKey("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"),
  new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
  new PublicKey("BPFLoader2111111111111111111111111111111111"),
  new PublicKey("Stake11111111111111111111111111111111111111"),
  new PublicKey("Vote111111111111111111111111111111111111111"),
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// spl-token errors carry only a name, so fall back to it.
export const errText = (e) => String(e?.message || e?.name || e).slice(0, 200);
export const onCurve = (key) => PublicKey.isOnCurve(key.toBytes());
export const keySet = (keys) => new Set(keys.filter(Boolean).map((k) => k.toBase58()));

/** A base58 address as a PublicKey, only if it is canonical; otherwise null. */
export function parseKey(value) {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return null;
  try {
    const key = new PublicKey(value);
    return key.toBase58() === value ? key : null;
  } catch {
    return null;
  }
}

/** JSON for the ledger's detail column: bigints and keys as strings. */
export const toJson = (value) =>
  value == null
    ? null
    : JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : v));

/** A token account's amount from simulateTransaction's `accounts` result, or 0n if it does not exist. */
export function simulatedAmount(account, { owner, mint, program }) {
  if (!account) return 0n;
  const data = Buffer.from(Array.isArray(account.data) ? account.data[0] : account.data, "base64");
  if (String(account.owner) !== program.toBase58() || data.length < 72)
    throw Error("simulated token account is not a token account");
  if (!new PublicKey(data.subarray(0, 32)).equals(mint) || !new PublicKey(data.subarray(32, 64)).equals(owner))
    throw Error("simulated token account does not match");
  return data.readBigUInt64LE(64);
}
