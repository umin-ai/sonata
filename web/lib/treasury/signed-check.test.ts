import test from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { LIGHTHOUSE_PROGRAM, signedChange } from "./signed-check.ts";
import { PublicKey } from "@solana/web3.js";

const payer = Keypair.generate().publicKey;
const blockhash = "11111111111111111111111111111111";
const swap = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) });
const built = () => {
  const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), swap);
  return tx;
};
const lighthouse = new TransactionInstruction({ programId: new PublicKey(LIGHTHOUSE_PROGRAM), keys: [{ pubkey: payer, isSigner: false, isWritable: false }], data: Buffer.from([9]) });

test("a wallet may add a priority fee and Lighthouse checks, or replace our compute limit", () => {
  const signed = new Transaction({ feePayer: payer, recentBlockhash: blockhash });
  signed.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), swap, lighthouse);
  assert.equal(signedChange(built(), signed), null);
  assert.equal(signedChange(built(), built()), null);
});

test("anything else a wallet changes is refused", () => {
  const other = new Transaction({ feePayer: payer, recentBlockhash: blockhash });
  other.add(swap, SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  assert.match(signedChange(built(), other)!, /added or changed an instruction for program 11111111111111111111111111111111/);
  const changed = new Transaction({ feePayer: payer, recentBlockhash: blockhash });
  changed.add(new TransactionInstruction({ ...swap, data: Buffer.from([1, 2, 4]) }));
  assert.match(signedChange(built(), changed)!, /changed an instruction/);
  const removed = new Transaction({ feePayer: payer, recentBlockhash: blockhash });
  removed.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  assert.equal(signedChange(built(), removed), "an instruction was removed");
  const otherPayer = new Transaction({ feePayer: Keypair.generate().publicKey, recentBlockhash: blockhash });
  otherPayer.add(swap);
  assert.equal(signedChange(built(), otherPayer), "the fee payer changed");
});
