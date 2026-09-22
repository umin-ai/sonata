// SPDX-License-Identifier: GPL-3.0-or-later
// Creates Devnet mock stock quote tokens with the same profile as mSPY:
// Token-2022, 8 decimals, no freeze authority, and only the MetadataPointer
// and TokenMetadata extensions. That profile is on Meteora DBC's
// permissionless allowlist, so these can be launch quote assets without a
// token badge. Mock tokens have no monetary value.
//
// Idempotent: a mint that already exists is verified and left alone.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  getExtensionTypes,
  unpackMint,
  getTokenMetadata,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  TYPE_SIZE,
  LENGTH_SIZE,
} from "@solana/spl-token";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";
import assert from "node:assert/strict";

const DECIMALS = 8;
const SUPPLY_UI = 10_000n; // minted to the deployer for Devnet launches and graduation demos
const TOKENS = [
  { symbol: "mQQQ", name: "Mock Nasdaq-100 (Sonata devnet)", key: ".keys/mock-mqqq.json" },
  { symbol: "mTSLA", name: "Mock Tesla (Sonata devnet)", key: ".keys/mock-mtsla.json" },
];

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(await conn.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "Not Devnet.");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/deployer.json"))));
const load = (path) => {
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path))));
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
  return kp;
};

const results = [];
for (const t of TOKENS) {
  const mint = load(t.key);
  const traces = [];
  if (!(await conn.getAccountInfo(mint.publicKey))) {
    const metadata = { mint: mint.publicKey, name: t.name, symbol: t.symbol, uri: "", additionalMetadata: [] };
    const mintLen = getMintLen([ExtensionType.MetadataPointer]);
    const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
    const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + metadataLen);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMetadataPointerInstruction(mint.publicKey, admin.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, DECIMALS, admin.publicKey, null, TOKEN_2022_PROGRAM_ID),
      createInitializeInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint.publicKey,
        updateAuthority: admin.publicKey,
        mint: mint.publicKey,
        mintAuthority: admin.publicKey,
        name: t.name,
        symbol: t.symbol,
        uri: "",
      }),
    );
    const sig = await sendAndConfirmTransaction(conn, tx, [admin, mint], { commitment: "confirmed" });
    traces.push({ label: `Create ${t.symbol} mint with metadata`, signature: sig });
    console.log(`${t.symbol} created: ${sig}`);

    const ata = getAssociatedTokenAddressSync(mint.publicKey, admin.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const mintTx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata, admin.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
      createMintToInstruction(mint.publicKey, ata, admin.publicKey, SUPPLY_UI * 10n ** BigInt(DECIMALS), [], TOKEN_2022_PROGRAM_ID),
    );
    const mintSig = await sendAndConfirmTransaction(conn, mintTx, [admin], { commitment: "confirmed" });
    traces.push({ label: `Mint ${SUPPLY_UI} ${t.symbol} to the deployer`, signature: mintSig });
    console.log(`${t.symbol} minted: ${mintSig}`);
  } else console.log(`${t.symbol} already exists; verifying.`);

  // Verify the profile matches mSPY and Meteora's permissionless allowlist.
  const info = await conn.getAccountInfo(mint.publicKey);
  const m = unpackMint(mint.publicKey, info, TOKEN_2022_PROGRAM_ID);
  const extensions = getExtensionTypes(m.tlvData).map((e) => ExtensionType[e]).sort();
  const md = await getTokenMetadata(conn, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
  const checks = {
    token2022: info.owner.equals(TOKEN_2022_PROGRAM_ID),
    decimals8: m.decimals === DECIMALS,
    noFreezeAuthority: m.freezeAuthority === null,
    onlyMetadataExtensions: JSON.stringify(extensions) === JSON.stringify(["MetadataPointer", "TokenMetadata"]),
    symbolMatches: md?.symbol === t.symbol,
  };
  for (const [k, ok] of Object.entries(checks)) assert.ok(ok, `${t.symbol}: ${k} failed`);
  results.push({ symbol: t.symbol, name: md.name, mint: mint.publicKey.toBase58(), decimals: m.decimals, supply: m.supply.toString(), extensions, checks, traces });
}

writeFileSync(
  "artifacts/mock-quote-mints.json",
  JSON.stringify({ network: "solana:devnet", createdAt: new Date().toISOString(), note: "Mock stock quote tokens, no monetary value. Same profile as mSPY; permissionless DBC quote assets.", tokens: results }, null, 2),
);
console.log(JSON.stringify(results.map(({ symbol, mint, checks }) => ({ symbol, mint, checks })), null, 2));
