// What a wallet changed in a transaction it signed, compared with the one the
// page built. Wallets such as Phantom may add their own instructions before
// signing: a compute-budget priority fee, or Lighthouse checks that make the
// transaction fail if balances move differently than simulated. Those are
// accepted. Anything else (a changed or removed instruction, another fee
// payer or blockhash, an instruction for any other program) is refused.
import { ComputeBudgetProgram, type Transaction, type TransactionInstruction } from "@solana/web3.js";

export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
const WALLET_ADDED = new Set([ComputeBudgetProgram.programId.toBase58(), LIGHTHOUSE_PROGRAM]);

// Same program, data and accounts. Account flags are not compared: a message
// merges each account's flags across its instructions, so an added
// instruction can mark an existing account writable in every instruction.
function sameInstruction(a: TransactionInstruction, b: TransactionInstruction) {
  return (
    a.programId.equals(b.programId) &&
    a.data.equals(b.data) &&
    a.keys.length === b.keys.length &&
    a.keys.every((k, i) => k.pubkey.equals(b.keys[i].pubkey))
  );
}

/** Why the signed transaction is not the built one plus wallet additions, or null when it is. */
export function signedChange(built: Transaction, signed: Transaction): string | null {
  if (!built.feePayer || !signed.feePayer?.equals(built.feePayer)) return "the fee payer changed";
  if (signed.recentBlockhash !== built.recentBlockhash) return "the blockhash changed";
  // Compute-budget instructions are the wallet's to set, including ours it may replace.
  const budget = ComputeBudgetProgram.programId;
  const ours = built.instructions.filter((ix) => !ix.programId.equals(budget));
  const theirs = signed.instructions.filter((ix) => !WALLET_ADDED.has(ix.programId.toBase58()));
  for (let i = 0; i < Math.max(ours.length, theirs.length); i++) {
    if (!theirs[i]) return "an instruction was removed";
    if (!ours[i] || !sameInstruction(ours[i], theirs[i]))
      return `it added or changed an instruction for program ${theirs[i].programId.toBase58()}`;
  }
  return null;
}
