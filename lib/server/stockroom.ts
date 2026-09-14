// SPDX-License-Identifier: GPL-3.0-or-later
import { Buffer } from "buffer";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
} from "@solana/spl-token";
import { z } from "zod";
import { createClient, CREDIT_ID } from "../stockroom/client.mjs";
import creditIdl from "../stockroom/idl/stockroom_credit.json";
import oracleIdl from "../stockroom/idl/demo_oracle.json";
import config from "../stockroom/deployment.json";
export const SponsorRequest = z
  .object({
    wallet: z.string().min(32).max(44),
    kind: z.enum(["faucet", "open", "borrow", "withdraw"]),
    transaction: z.string().max(1800),
  })
  .strict();
function equalInstruction(
  a: TransactionInstruction,
  b: TransactionInstruction,
) {
  return (
    a.programId.equals(b.programId) &&
    a.data.equals(b.data) &&
    a.keys.length === b.keys.length &&
    a.keys.every(
      (k, i) =>
        k.pubkey.equals(b.keys[i].pubkey) &&
        k.isSigner === b.keys[i].isSigner &&
        k.isWritable === b.keys[i].isWritable,
    )
  );
}
// Only fixed demo grants and price updates may use the disposable signer.
// This key has no program upgrade authority. No RPC is used by this endpoint.
export async function verifySponsor(input: z.infer<typeof SponsorRequest>) {
  const owner = new PublicKey(input.wallet),
    admin = new PublicKey(config.admin);
  if (!PublicKey.isOnCurve(owner.toBytes()) || owner.equals(admin))
    throw Error("A separate user wallet is required.");
  const bytes = Buffer.from(input.transaction, "base64");
  if (bytes.length > 1232) throw Error("Transaction too large.");
  const tx = Transaction.from(bytes);
  if (
    !tx.recentBlockhash ||
    tx.signatures.length !== 2 ||
    tx.signatures.some(
      (s) => !s.publicKey.equals(owner) && !s.publicKey.equals(admin),
    )
  )
    throw Error("Unexpected transaction signers.");
  const c = createClient(
    creditIdl,
    oracleIdl,
    { connection: new Connection("https://api.devnet.solana.com") },
    {
      admin,
      collateralMint: new PublicKey(config.collateralMint),
      debtMint: new PublicKey(config.debtMint),
      oracleAccount: new PublicKey(config.oracleAccount),
    },
  );
  const compute = ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 });
  if (input.kind === "faucet") {
    if (!tx.feePayer?.equals(admin))
      throw Error("Unexpected faucet fee payer.");
    const expected = [
      compute,
      SystemProgram.transfer({
        fromPubkey: admin,
        toPubkey: owner,
        lamports: 5000000,
      }),
      createAssociatedTokenAccountIdempotentInstruction(
        admin,
        c.cash(owner).userCash,
        owner,
        new PublicKey(config.debtMint),
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        admin,
        c.collateral(owner).userStock,
        owner,
        new PublicKey(config.collateralMint),
        TOKEN_2022_PROGRAM_ID,
      ),
      createMintToCheckedInstruction(
        new PublicKey(config.debtMint),
        c.cash(owner).userCash,
        admin,
        1000000000n,
        6,
      ),
      createMintToCheckedInstruction(
        new PublicKey(config.collateralMint),
        c.collateral(owner).userStock,
        admin,
        2500000000n,
        8,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
      await c.initializePosition(owner),
    ];
    // Canonical messages promote duplicate keys' privileges identically.
    const canonical = Transaction.from(
      new Transaction({ feePayer: admin, recentBlockhash: tx.recentBlockhash })
        .add(...expected)
        .serialize({ requireAllSignatures: false, verifySignatures: false }),
    );
    if (!tx.serializeMessage().equals(canonical.serializeMessage()))
      throw Error("Faucet transaction differs from the fixed starter pack.");
  } else {
    if (
      !tx.feePayer?.equals(owner) ||
      tx.instructions.length !== (input.kind === "open" ? 4 : 3)
    )
      throw Error("Unexpected sponsored transaction.");
    const oracleIx = await c.publish(200000000n);
    if (
      !equalInstruction(tx.instructions[0], compute) ||
      !equalInstruction(tx.instructions[1], oracleIx)
    )
      throw Error("Only the fixed demo price may be published.");
    const names =
      input.kind === "open"
        ? ["deposit_collateral", "borrow"]
        : input.kind === "borrow"
          ? ["borrow"]
          : ["withdraw_collateral"];
    for (let i = 2; i < tx.instructions.length; i++) {
      const ix = tx.instructions[i],
        idl = creditIdl.instructions.find((x) => x.name === names[i - 2]);
      if (
        !idl ||
        !ix.programId.equals(CREDIT_ID) ||
        !ix.data.subarray(0, 8).equals(Buffer.from(idl.discriminator)) ||
        ix.keys.some((k) => k.pubkey.equals(admin)) ||
        !ix.keys.some((k) => k.pubkey.equals(owner) && k.isSigner)
      )
        throw Error("Unexpected instruction or use of the demo authority.");
    }
  }
  return tx;
}
export async function cosignDemo(input: z.infer<typeof SponsorRequest>) {
  const tx = await verifySponsor(input),
    value = process.env.STOCKROOM_DEMO_AUTHORITY;
  if (!value) throw Error("The demo faucet is not configured yet.");
  const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(value)));
  if (signer.publicKey.toBase58() !== config.admin)
    throw Error("Demo signer mismatch.");
  tx.partialSign(signer);
  return {
    network: "solana:devnet",
    transaction: tx
      .serialize({ requireAllSignatures: false, verifySignatures: true })
      .toString("base64"),
  };
}
