// SPDX-License-Identifier: GPL-3.0-or-later
// Devnet only. Names Sonata as the launchpad behind every DBC pool whose config
// uses the Sonata Vault as fee claimer, through Meteora's partner metadata. The
// treasury program's create_partner_metadata signs as the Vault; the Vault admin
// (.keys/deployer.json) pays. DBC allows this once per fee claimer, so a second
// run only reads the account back. Writes artifacts/partner-metadata.json.
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import { createDbcProgram } from "@meteora-ag/dynamic-bonding-curve-sdk";

const NAME = "Sonata",
  WEBSITE = "https://sonata.umin.ai",
  LOGO = "https://sonata.umin.ai/sonata-logo.png";
const DBC = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
assert.equal(await conn.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "Not Devnet.");

const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/deployer.json", "utf8"))));
const idl = JSON.parse(readFileSync("target/idl/stockroom_treasury.json", "utf8"));
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" }));
const [vault] = PublicKey.findProgramAddressSync([Buffer.from("stockroom")], program.programId);
const [partnerMetadata] = PublicKey.findProgramAddressSync([Buffer.from("partner_metadata"), vault.toBuffer()], DBC);
const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DBC);
const v = await program.account.vault.fetch(vault);
assert.ok(v.admin.equals(admin.publicKey), "deployer is not the Vault admin");

let signature = null;
if (!(await conn.getAccountInfo(partnerMetadata))) {
  signature = await program.methods
    .createPartnerMetadata(NAME, WEBSITE, LOGO)
    .accountsPartial({
      vault,
      admin: admin.publicKey,
      partnerMetadata,
      systemProgram: SystemProgram.programId,
      dbcEventAuthority: eventAuthority,
      dbcProgram: DBC,
    })
    .rpc();
  console.log("created:", signature);
}

const info = await conn.getAccountInfo(partnerMetadata);
assert.ok(info?.owner.equals(DBC), "partner metadata is not owned by DBC");
const m = createDbcProgram(conn).program.coder.accounts.decode("partnerMetadata", info.data);
const evidence = {
  network: "solana:devnet",
  checkedAt: new Date().toISOString(),
  intent: "Meteora DBC partner metadata naming Sonata as the launchpad for every pool whose fee claimer is the Sonata Vault.",
  vault: vault.toBase58(),
  partnerMetadata: partnerMetadata.toBase58(),
  signature,
  onchain: { feeClaimer: m.feeClaimer.toBase58(), name: m.name, website: m.website, logo: m.logo },
  checks: {
    ownedByDbc: true,
    feeClaimerIsVault: m.feeClaimer.equals(vault),
    fields: m.name === NAME && m.website === WEBSITE && m.logo === LOGO,
  },
};
assert.ok(evidence.checks.feeClaimerIsVault && evidence.checks.fields, "partner metadata does not match");
// Keep the creation record; a rerun only reads back and prints.
if (signature) writeFileSync("artifacts/partner-metadata.json", JSON.stringify(evidence, null, 2) + "\n");
console.log(evidence);
