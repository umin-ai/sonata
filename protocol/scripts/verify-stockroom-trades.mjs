// Read-only Devnet regression: receipts, balance conservation and executable slippage protection.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import {
  Connection,
  PublicKey,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  getCurrentPoint,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import anchor from "@coral-xyz/anchor";
const m = JSON.parse(readFileSync("../cash-access/lib/treasury/market.json"));
const c = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(
  await c.getGenesisHash(),
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
);
const wallet = "ACbRB4yPfUikHAaXhWzJXH4pjSPf6rk82Jot1JqRQ3Ft";
const signatures = {
  buy: "3M4JovtDewj2nDwr4Ft32TDX7Ys3VbzG4ZnsEtNPHpdVC1SfjyVHRtfUqgACe5LYsxJdWYv2KT4eagYxBi99mhNB",
  collect:
    "2SdxvSZ7UBP1LvGkDNLuTLoLvpPLpHp3ynXQNhDAwnHXUEn797GJnQXaA9q3gjE1TXBqsvncZmBwwrczZufwsCj8",
  allocate:
    "2c2mZe5HoUUZFpxDX3Penb8xq8EpBrFWCZPCtbyJ2o6fgsi5kaidDzpLEAAeZ5szQA3U9TwnEC27eJLsbTJrpWBo",
  sell: "2i6sJUM9x5ktw42XzJ8whFqtwtbEHMaNHBGDo9SujB5kETYGydrqxhkcpfqA79TwZTbvQJtbSVnqmEr9ssXfrC1q",
};
const deltas = {};
for (const [action, signature] of Object.entries(signatures)) {
  const tx = await c.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  assert.ok(tx?.meta);
  assert.equal(tx.meta.err, null);
  assert.equal(tx.transaction.message.staticAccountKeys[0].toBase58(), wallet);
  const pre = tx.meta.preTokenBalances ?? [],
    post = tx.meta.postTokenBalances ?? [];
  const records = [
    ...new Map([...pre, ...post].map((x) => [x.accountIndex, x])).values(),
  ];
  deltas[action] = records.map((x) => ({
    account:
      tx.transaction.message.staticAccountKeys[x.accountIndex].toBase58(),
    owner: x.owner,
    mint: x.mint,
    delta: (
      BigInt(
        post.find((y) => y.accountIndex === x.accountIndex)?.uiTokenAmount
          .amount ?? "0",
      ) -
      BigInt(
        pre.find((y) => y.accountIndex === x.accountIndex)?.uiTokenAmount
          .amount ?? "0",
      )
    ).toString(),
  }));
  for (const mint of [m.baseMint, m.quoteMint])
    assert.equal(
      deltas[action]
        .filter((x) => x.mint === mint)
        .reduce((a, x) => a + BigInt(x.delta), 0n),
      0n,
      `${action} token conservation`,
    );
}
const delta = (action, account) =>
  BigInt(deltas[action].find((x) => x.account === account)?.delta ?? "0");
assert.equal(delta("collect", m.treasuryQuote), 240800n);
assert.equal(delta("allocate", m.treasuryQuote), -120400n);
assert.equal(delta("allocate", m.payoutQuote), 120400n);
assert.equal(
  deltas.buy.find((x) => x.owner === wallet && x.mint === m.quoteMint).delta,
  "-100000",
);
assert.equal(
  deltas.buy.find((x) => x.owner === wallet && x.mint === m.baseMint).delta,
  "279748064691",
);
assert.equal(
  deltas.sell.find((x) => x.owner === wallet && x.mint === m.baseMint).delta,
  "-10000000000",
);
assert.equal(
  deltas.sell.find((x) => x.owner === wallet && x.mint === m.quoteMint).delta,
  "3503",
);
const d = new DynamicBondingCurveClient(c, "confirmed");
const [pool, config] = await Promise.all([
  d.state.getPool(new PublicKey(m.pool)),
  d.state.getPoolConfig(new PublicKey(m.config)),
]);
const amountIn = new anchor.BN("1000000");
const q = d.pool.swapQuote({
  virtualPool: pool,
  config,
  swapBaseForQuote: false,
  amountIn,
  slippageBps: 50,
  hasReferral: false,
  eligibleForFirstSwapWithMinFee: false,
  currentPoint: await getCurrentPoint(c, config.activationType),
});
const simulate = async (minimumAmountOut) => {
  const tx = await d.pool.swap({
    owner: new PublicKey(wallet),
    pool: new PublicKey(m.pool),
    amountIn,
    minimumAmountOut,
    swapBaseForQuote: false,
    referralTokenAccount: null,
  });
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
  );
  tx.feePayer = new PublicKey(wallet);
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  return (
    await c.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
      sigVerify: false,
      commitment: "confirmed",
    })
  ).value;
};
const good = await simulate(q.minimumAmountOut);
assert.equal(good.err, null, JSON.stringify(good.err));
const bad = await simulate(q.outputAmount.muln(100));
assert.ok(bad.err);
assert.ok(
  bad.logs.some((x) => /ExceededSlippage|slippage/i.test(x)),
  bad.logs.join("\n"),
);
const evidence = {
  verifiedAt: new Date().toISOString(),
  network: "devnet",
  wallet,
  program: m.programId,
  pool: m.pool,
  signatures,
  deltas,
  checks: [
    "four browser-signed transactions confirmed",
    "token conservation for both mints",
    "claim deposited 240800 atoms",
    "allocation paid 120400 and retained 120400 atoms",
    "buy and sell wallet deltas verified",
    "live quote simulation passed",
    "unachievable minimum rejected with slippage error",
  ],
  slippageFailure: bad.err,
};
writeFileSync(
  "../cash-access/evidence/treasury-trading-lifecycle.json",
  JSON.stringify(evidence, null, 2),
);
console.log({ checks: evidence.checks, slippageFailure: bad.err });
