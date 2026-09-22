// Named disposable Devnet recipient only. Completes the second browser-created test allocation.
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  Connection,
  PublicKey,
  Keypair,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
const c = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(
  await c.getGenesisHash(),
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
);
const p = new anchor.Program(
    JSON.parse(readFileSync("sdk/idl/stockroom_rewards.json")),
    { connection: c },
  ),
  campaign = new PublicKey("DKxuabBy6yUHZ3nyQeuNR7WQnM8UzWfz2SV2sL8ddBT2"),
  recipient = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(".keys/lp-alice.json"))),
  );
const state = await p.account.campaign.fetch(campaign),
  index = state.allocations.findIndex((a) =>
    a.recipient.equals(recipient.publicKey),
  );
assert(index >= 0);
assert.equal(
  state.creator.toBase58(),
  "ACbRB4yPfUikHAaXhWzJXH4pjSPf6rk82Jot1JqRQ3Ft",
);
if (state.claimedMask & (1 << index)) {
  console.log("Already claimed. No transaction sent.");
  process.exit(0);
}
const ata = (o) =>
  getAssociatedTokenAddressSync(state.mint, o, true, TOKEN_2022_PROGRAM_ID);
const tx = await p.methods
  .claim(index)
  .accounts({
    campaign,
    escrow: ata(campaign),
    mint: state.mint,
    recipient: recipient.publicKey,
    destination: ata(recipient.publicKey),
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  })
  .transaction();
const signature = await sendAndConfirmTransaction(c, tx, [recipient], {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
const after = await p.account.campaign.fetch(campaign);
assert.equal(after.claimedMask, 3);
assert.equal(after.claimed.toString(), "80");
const e = {
  network: "devnet",
  campaign: campaign.toBase58(),
  signature,
  recipient: recipient.publicKey.toBase58(),
  amount: state.allocations[index].amount.toString(),
  claimedMask: after.claimedMask,
  verifiedAt: new Date().toISOString(),
};
writeFileSync(
  "artifacts/stockroom-rewards-browser-peer.json",
  JSON.stringify(e, null, 2) + "\n",
);
console.log(e);
