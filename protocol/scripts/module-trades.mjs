// SPDX-License-Identifier: GPL-3.0-or-later
// Makes test trades on a Sonata market so its fee module has something to pay:
// each wallet buys (in the quote stock) or sells (a share of its tokens) through
// the bonding curve, one after another. Tops wallets up from the deployer with
// Devnet SOL and the mock quote stock (no monetary value) when they run short.
// Refuses to run anywhere but Devnet, and refuses the flagship ROOM/mSPY pool.
//
// Usage: node scripts/module-trades.mjs <pool> <wallet>:<buy|sell>:<amount> ... [--out file.json]
//   wallet: alice | bob | trader | holder (keys in .keys/)
//   buy amount: quote stock, e.g. 0.3; sell amount: share of the wallet's tokens, e.g. 0.5
import { readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import assert from "node:assert/strict";
import { DynamicBondingCurveClient, swapQuote, getCurrentPoint } from "@meteora-ag/dynamic-bonding-curve-sdk";

const FLAGSHIP = "BZVxHsS8DQAkigYvQAPfssFGZRVSuWSYHrYQn2QmeFSf";
const WALLETS = { alice: "lp-alice", bob: "lp-bob", trader: "lp-trader", holder: "floor-holder" };
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : null;
const [poolArg, ...steps] = args;
assert.ok(poolArg && steps.length, "Usage: module-trades.mjs <pool> <wallet>:<buy|sell>:<amount> ...");
assert.notEqual(poolArg, FLAGSHIP, "Never trade the flagship pool from a script.");

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(await conn.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "Not Devnet.");
const key = (name) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`.keys/${name}.json`))));
const deployer = key("deployer");
const dbc = new DynamicBondingCurveClient(conn, "confirmed");
const pool = new PublicKey(poolArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wrapped = await dbc.state.getPool(pool);
assert.ok(wrapped, "Pool not found.");
const config = await dbc.state.getPoolConfig(wrapped.poolState.config);
const baseMint = wrapped.poolState.baseMint,
  quoteMint = config.quoteMint;
const decimals = 8;

// Top up SOL for fees and rent, and the quote stock for buys.
async function topUp(wallet, quoteAtoms) {
  const tx = new Transaction();
  if ((await conn.getBalance(wallet.publicKey)) < 20_000_000)
    tx.add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: wallet.publicKey, lamports: 50_000_000 }));
  const ata = getAssociatedTokenAddressSync(quoteMint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const held = await conn.getTokenAccountBalance(ata).then((b) => BigInt(b.value.amount)).catch(() => 0n);
  if (held < quoteAtoms) {
    const from = getAssociatedTokenAddressSync(quoteMint, deployer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, ata, wallet.publicKey, quoteMint, TOKEN_2022_PROGRAM_ID),
      createTransferCheckedInstruction(from, quoteMint, ata, deployer.publicKey, quoteAtoms - held, decimals, [], TOKEN_2022_PROGRAM_ID),
    );
  }
  if (tx.instructions.length) await sendAndConfirmTransaction(conn, tx, [deployer], { commitment: "confirmed" });
}

const traces = [];
for (const step of steps) {
  const [who, side, amount] = step.split(":");
  assert.ok(WALLETS[who], `Unknown wallet ${who}.`);
  assert.ok(side === "buy" || side === "sell", `Use buy or sell, not ${side}.`);
  const wallet = key(WALLETS[who]);
  const state = await dbc.state.getPool(pool);
  assert.equal(state.poolState.isMigrated, 0, "Pool has graduated; these trades use the curve.");
  let amountIn;
  if (side === "buy") {
    amountIn = BigInt(Math.round(Number(amount) * 10 ** decimals));
    await topUp(wallet, amountIn);
  } else {
    await topUp(wallet, 0n);
    const baseAta = getAssociatedTokenAddressSync(baseMint, wallet.publicKey, false, TOKEN_PROGRAM_ID);
    const held = BigInt((await conn.getTokenAccountBalance(baseAta)).value.amount);
    amountIn = (held * BigInt(Math.round(Number(amount) * 1000))) / 1000n;
    assert.ok(amountIn > 0n, `${who} holds no tokens to sell.`);
  }
  const quote = swapQuote(
    state,
    config,
    side === "sell",
    new BN(amountIn.toString()),
    200,
    false,
    await getCurrentPoint(conn, config.activationType),
    false,
  );
  const tx = await dbc.pool.swap({
    owner: wallet.publicKey,
    pool,
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: quote.minimumAmountOut,
    swapBaseForQuote: side === "sell",
    referralTokenAccount: null,
  });
  const signature = await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: "confirmed" });
  traces.push({ wallet: wallet.publicKey.toBase58(), who, side, amountIn: amountIn.toString(), signature });
  console.log(`${who} ${side} ${amountIn} → ${signature}`);
  await sleep(1500);
}
if (out) writeFileSync(out, JSON.stringify({ pool: pool.toBase58(), network: "devnet", traces }, null, 2) + "\n");
