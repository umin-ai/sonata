// SPDX-License-Identifier: GPL-3.0-or-later
// Sends Devnet SOL and a mock quote token (no monetary value) from the deployer
// to a wallet, for demos and UI tests. Refuses to run anywhere but Devnet.
// Usage: node scripts/fund-devnet-wallet.mjs <address> [sol=0.2] [symbol=mQQQ] [amount=5]
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import assert from "node:assert/strict";

const [address, sol = "0.2", symbol = "mQQQ", amount = "5"] = process.argv.slice(2);
assert.ok(address, "Pass the wallet address to fund.");
const to = new PublicKey(address);
assert.ok(PublicKey.isOnCurve(to.toBytes()), "Not a normal wallet address.");
const asset = JSON.parse(readFileSync("../cash-access/lib/treasury/quote-assets.json", "utf8")).assets.find((a) => a.symbol === symbol);
assert.ok(asset, `${symbol} has no Devnet mint in the registry.`);
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(await conn.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "Not Devnet.");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/deployer.json"))));
const mint = new PublicKey(asset.mint);
const atoms = BigInt(Math.round(Number(amount) * 10 ** asset.decimals));
const lamports = Math.round(Number(sol) * 1e9);
assert.ok(lamports <= 2e9 && atoms > 0n, "Keep demo funding small.");
const dest = getAssociatedTokenAddressSync(mint, to, false, TOKEN_2022_PROGRAM_ID);
const signature = await sendAndConfirmTransaction(conn, new Transaction().add(
  SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: to, lamports }),
  createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, dest, to, mint, TOKEN_2022_PROGRAM_ID),
  createTransferCheckedInstruction(
    getAssociatedTokenAddressSync(mint, admin.publicKey, false, TOKEN_2022_PROGRAM_ID),
    mint, dest, admin.publicKey, atoms, asset.decimals, [], TOKEN_2022_PROGRAM_ID,
  ),
), [admin], { commitment: "confirmed" });
console.log(`Sent ${sol} Devnet SOL and ${amount} ${symbol} to ${address}: ${signature}`);
