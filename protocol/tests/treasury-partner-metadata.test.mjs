// SPDX-License-Identifier: GPL-3.0-or-later
// Partner metadata names Sonata as the launchpad behind every pool whose config
// uses the Vault as fee claimer. DBC creates it once per fee claimer with no
// update, so only the Vault admin may call it. The DBC side of the call is proven
// on Devnet by scripts/verify-partner-metadata.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { getTransactionDecoder } from "@solana/kit";
import { Keypair, PublicKey, Connection, Transaction, SystemProgram } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
const idl = JSON.parse(readFileSync("target/idl/stockroom_treasury.json")),
  id = new PublicKey(idl.address),
  DBC = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

test("only the Vault admin can create the partner metadata", async () => {
  const svm = new LiteSVM();
  svm.addProgramFromFile(id.toBase58(), "target/deploy/stockroom_treasury.so");
  // A stand-in executable at DBC's address, so account checks reach the admin check.
  svm.addProgramFromFile(DBC.toBase58(), "target/deploy/demo_oracle.so");
  const admin = Keypair.generate(),
    attacker = Keypair.generate();
  for (const k of [admin, attacker]) svm.airdrop(k.publicKey.toBase58(), 10_000_000_000n);
  const program = new anchor.Program(
    idl,
    new anchor.AnchorProvider(new Connection("http://127.0.0.1:8899"), new anchor.Wallet(admin), {}),
  );
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("stockroom")], id),
    [partnerMetadata] = PublicKey.findProgramAddressSync(
      [Buffer.from("partner_metadata"), vault.toBuffer()],
      DBC,
    ),
    [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DBC);
  const send = async (ix, signer) => {
    svm.expireBlockhash();
    const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: svm.latestBlockhash() }).add(await ix);
    tx.sign(signer);
    return svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
  };
  const init = await send(
    program.methods.initVault().accountsPartial({ vault, admin: admin.publicKey, systemProgram: SystemProgram.programId }).instruction(),
    admin,
  );
  assert(!(init instanceof FailedTransactionMetadata), "vault init failed");
  const create = (signer) =>
    program.methods
      .createPartnerMetadata("Sonata", "https://sonata.umin.ai", "https://sonata.umin.ai/sonata-logo.png")
      .accountsPartial({
        vault,
        admin: signer.publicKey,
        partnerMetadata,
        systemProgram: SystemProgram.programId,
        dbcEventAuthority: eventAuthority,
        dbcProgram: DBC,
      })
      .instruction();
  const refused = await send(create(attacker), attacker);
  assert(refused instanceof FailedTransactionMetadata, "a non-admin call must fail");
  assert.match(refused.meta().logs().join("\n"), /Unauthorized/);
  // The admin passes the Vault's check; the stand-in then rejects the CPI.
  const admitted = await send(create(admin), admin);
  assert(admitted instanceof FailedTransactionMetadata);
  assert.doesNotMatch(admitted.meta().logs().join("\n"), /Unauthorized/);
});
