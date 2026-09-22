// Read-only audit of the four browser-driven actions; no wallet secrets required.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
const c = new Connection("https://api.devnet.solana.com", {
  commitment: "confirmed",
  fetch: async (...args) => {
    await new Promise((r) => setTimeout(r, 1200));
    return fetch(...args);
  },
});
assert.equal(
  await c.getGenesisHash(),
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
);
const wallet = "ACbRB4yPfUikHAaXhWzJXH4pjSPf6rk82Jot1JqRQ3Ft",
  position = "JDfwnMdnKp4BnnwJAbezrNyXPmKM6JGqgCCwjSj2f96v";
const m = JSON.parse(readFileSync("artifacts/stockroom-liquidity-market.json")),
  amm = new CpAmm(c),
  rows = [];
const signatures = await c.getSignaturesForAddress(
  new PublicKey(position),
  { limit: 10 },
  "confirmed",
);
for (const receipt of signatures.reverse()) {
  const tx = await c.getTransaction(receipt.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  assert(tx?.meta);
  assert.equal(tx.meta.err, null);
  const keys = tx.transaction.message.staticAccountKeys;
  const instructions = tx.transaction.message.compiledInstructions
    .filter((i) => keys[i.programIdIndex].toBase58() === m.programId)
    .map(
      (i) => amm._program.coder.instruction.decode(Buffer.from(i.data))?.name,
    );
  const deltas = Object.fromEntries(
    [m.tokenAMint, m.tokenBMint].map((mint) => {
      const sum = (bs) =>
        bs
          .filter((b) => b.mint === mint && b.owner === wallet)
          .reduce((v, b) => v + BigInt(b.uiTokenAmount.amount), 0n);
      return [
        mint,
        (
          sum(tx.meta.postTokenBalances ?? []) -
          sum(tx.meta.preTokenBalances ?? [])
        ).toString(),
      ];
    }),
  );
  rows.push({
    signature: receipt.signature,
    slot: tx.slot,
    instructions,
    deltas,
  });
  await new Promise((r) => setTimeout(r, 400));
}
// Swaps touch the pool, not the position account; inspect only this wallet's pool transactions.
for (const receipt of await c.getSignaturesForAddress(
  new PublicKey(wallet),
  { limit: 8 },
  "confirmed",
)) {
  const tx = await c.getTransaction(receipt.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta || tx.meta.err) continue;
  const keys = tx.transaction.message.staticAccountKeys;
  if (!keys.some((k) => k.toBase58() === m.pool)) continue;
  const instructions = tx.transaction.message.compiledInstructions
    .filter((i) => keys[i.programIdIndex].toBase58() === m.programId)
    .map(
      (i) => amm._program.coder.instruction.decode(Buffer.from(i.data))?.name,
    );
  if (!instructions.some((n) => n?.startsWith("swap"))) continue;
  const deltas = Object.fromEntries(
    [m.tokenAMint, m.tokenBMint].map((mint) => {
      const sum = (bs) =>
        bs
          .filter((b) => b.mint === mint && b.owner === wallet)
          .reduce((v, b) => v + BigInt(b.uiTokenAmount.amount), 0n);
      return [
        mint,
        (
          sum(tx.meta.postTokenBalances ?? []) -
          sum(tx.meta.preTokenBalances ?? [])
        ).toString(),
      ];
    }),
  );
  rows.push({
    signature: receipt.signature,
    slot: tx.slot,
    instructions,
    deltas,
  });
  await new Promise((r) => setTimeout(r, 400));
}
rows.sort((a, b) => a.slot - b.slot);
assert.equal(rows.length, 4);
assert(rows[0].instructions.includes("addLiquidity"));
assert(rows[1].instructions.some((n) => n?.startsWith("swap")));
assert(rows[2].instructions.includes("removeLiquidity"));
assert(rows[3].instructions.includes("removeLiquidity"));
assert(
  BigInt(rows[0].deltas[m.tokenAMint]) < 0n &&
    BigInt(rows[0].deltas[m.tokenBMint]) < 0n,
);
for (const r of rows.slice(2))
  assert(
    BigInt(r.deltas[m.tokenAMint]) > 0n && BigInt(r.deltas[m.tokenBMint]) > 0n,
  );
const p = await amm.fetchPositionState(new PublicKey(position));
assert(p.unlockedLiquidity.isZero());
const output = {
  verifiedAt: new Date().toISOString(),
  network: "devnet",
  wallet,
  pool: m.pool,
  position,
  allUnlockedLiquidityRedeemed: true,
  receipts: rows,
};
writeFileSync(
  "../cash-access/evidence/liquidity-browser-lifecycle.json",
  JSON.stringify(output, null, 2) + "\n",
);
console.log(
  "Four browser transactions confirmed; no LP units remain.",
  rows.map((r) => ({ instructions: r.instructions, signature: r.signature })),
);
