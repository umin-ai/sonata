// Read-only verification of saved receipts; never funds or trades.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
const file = "artifacts/stockroom-liquidity-lifecycle.json",
  e = JSON.parse(readFileSync(file));
assert.equal(e.complete, true);
const c = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(
  await c.getGenesisHash(),
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
);
const verified = [];
for (const r of e.receipts) {
  const tx = await c.getTransaction(r.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  assert(tx?.meta, `Missing ${r.label}`);
  assert.equal(tx.meta.err, null);
  assert.equal(
    tx.transaction.message.staticAccountKeys[0].toBase58(),
    r.signer,
  );
  const changes = {};
  for (const mint of [e.pool.tokenAMint, e.pool.tokenBMint]) {
    const total = (rows) =>
      rows
        .filter((b) => b.mint === mint && b.owner === r.signer)
        .reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n);
    changes[mint] = (
      total(tx.meta.postTokenBalances ?? []) -
      total(tx.meta.preTokenBalances ?? [])
    ).toString();
  }
  if (r.label.startsWith("deposit-"))
    assert(
      BigInt(changes[e.pool.tokenAMint]) < 0n &&
        BigInt(changes[e.pool.tokenBMint]) < 0n,
    );
  if (r.label.includes("-exit")) {
    const expected = e.checks[r.label];
    assert.equal(changes[e.pool.tokenAMint], expected.aReceived);
    assert.equal(changes[e.pool.tokenBMint], expected.bReceived);
  }
  if (r.label === "independent-trade") {
    assert.equal(changes[e.pool.tokenAMint], "-" + e.tradeQuote.input);
    assert.equal(changes[e.pool.tokenBMint], e.tradeQuote.output);
    assert(![e.wallets.alice, e.wallets.bob].includes(r.signer));
  }
  verified.push({ ...r, slot: tx.slot, tokenDeltas: changes });
  await new Promise((r) => setTimeout(r, 400));
}
const amm = new CpAmm(c),
  s = await amm.fetchPoolState(new PublicKey(e.pool.pool));
assert.equal(s.collectFeeMode, 2);
assert.equal(s.poolFees.compoundingFeeBps, 10000);
for (const name of ["deposit-alice", "deposit-bob"]) {
  const p = await amm.fetchPositionState(
    new PublicKey(e.checks[name].position),
  );
  assert(p.pool.equals(new PublicKey(e.pool.pool)));
  assert(p.unlockedLiquidity.isZero());
}
const report = {
  verifiedAt: new Date().toISOString(),
  network: "devnet",
  pool: e.pool.pool,
  checkedReceipts: verified.length,
  checks: {
    bothDepositorsExited: true,
    independentTrader: true,
    allReceiptsSuccessful: true,
    withdrawalTokenAmountsMatch: true,
    nativeCompoundingMode: true,
  },
  receipts: verified,
};
writeFileSync(
  "artifacts/stockroom-liquidity-verification.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(report.checks, verified.length + " receipts verified");
