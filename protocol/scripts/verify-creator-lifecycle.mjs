// Read-only audit of the market created through Stockroom's local browser UI.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(
  await connection.getGenesisHash(),
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
);
const wallet = new PublicKey("ACbRB4yPfUikHAaXhWzJXH4pjSPf6rk82Jot1JqRQ3Ft");
const pool = new PublicKey("HhyKUtF8jZoMbmKD39Qo4DadrPCAdaF8KyrXT4LAMQbp");
const treasury = new PublicKey("8fTeNQk5x3FjuxEhc26PT7QgABr28tSQUU5WkZcL4xVW");
const idl = JSON.parse(
  readFileSync("../cash-access/lib/treasury/stockroom_treasury.json"),
);
const program = new anchor.Program(idl, { connection });
const state = await program.account.treasury.fetch(treasury);
assert.equal(state.creator.toBase58(), wallet.toBase58());
assert.equal(state.payoutOwner.toBase58(), wallet.toBase58());
assert.equal(state.pool.toBase58(), pool.toBase58());
assert.equal(
  PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), pool.toBuffer()],
    program.programId,
  )[0].toBase58(),
  treasury.toBase58(),
);
assert.deepEqual(state.mode, { duet: {} });
assert.equal(state.totalClaimed.toString(), "800");
assert.equal(state.totalDistributed.toString(), "400");
assert.equal(state.totalRetained.toString(), "400");
assert.equal(state.totalWithdrawn.toString(), "200");
const custody = getAssociatedTokenAddressSync(
  state.quoteMint,
  treasury,
  true,
  TOKEN_2022_PROGRAM_ID,
);
assert.equal(
  (await getAccount(connection, custody, "confirmed", TOKEN_2022_PROGRAM_ID))
    .amount,
  200n,
);
const histories = await Promise.all(
  [pool, treasury].map((a) =>
    connection.getSignaturesForAddress(a, { limit: 20 }, "confirmed"),
  ),
);
const signatures = [...new Set(histories.flat().map((r) => r.signature))];
const receipts = [];
for (const signature of signatures) {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  assert.equal(tx?.meta?.err, null);
  const keys = tx.transaction.message.staticAccountKeys;
  assert.ok(keys[0].equals(wallet));
  const pre = tx.meta.preTokenBalances ?? [],
    post = tx.meta.postTokenBalances ?? [];
  const deltas = [
    ...new Map([...pre, ...post].map((x) => [x.accountIndex, x])).values(),
  ].map((x) => ({
    account: keys[x.accountIndex].toBase58(),
    owner: x.owner,
    mint: x.mint,
    delta: (
      BigInt(
        post.find((y) => y.accountIndex === x.accountIndex)?.uiTokenAmount
          .amount ?? 0,
      ) -
      BigInt(
        pre.find((y) => y.accountIndex === x.accountIndex)?.uiTokenAmount
          .amount ?? 0,
      )
    ).toString(),
  }));
  const logs = tx.meta.logMessages ?? [];
  const action = logs.some((l) => l.includes("Instruction: WithdrawRetained"))
    ? "withdraw"
    : logs.some((l) => l.includes("Instruction: Distribute"))
      ? "allocate"
      : logs.some((l) => l.includes("Instruction: Claim"))
        ? "collect"
        : logs.some((l) => l.includes("Instruction: InitTreasury"))
          ? "register"
          : logs.some((l) =>
                l.includes("Instruction: InitializeVirtualPoolWithSplToken"),
              )
            ? "launch"
            : deltas.some(
                  (d) =>
                    d.owner === wallet.toBase58() &&
                    d.mint === state.baseMint.toBase58() &&
                    BigInt(d.delta) > 0n,
                )
              ? "buy"
              : "sell";
  // Minting the initial supply is the only allowed source of new community tokens.
  for (const mint of [state.baseMint, state.quoteMint]) {
    const sum = deltas
      .filter((d) => d.mint === mint.toBase58())
      .reduce((n, d) => n + BigInt(d.delta), 0n);
    assert.equal(
      sum,
      action === "launch" && mint.equals(state.baseMint)
        ? 1000000000000000n
        : 0n,
      `${action}: token conservation`,
    );
  }
  receipts.push({ action, signature, slot: tx.slot, deltas });
}
for (const action of [
  "launch",
  "register",
  "buy",
  "sell",
  "collect",
  "allocate",
  "withdraw",
])
  assert.equal(
    receipts.filter((r) => r.action === action).length,
    1,
    `${action}: exactly one successful receipt`,
  );
const delta = (action, owner, mint) =>
  BigInt(
    receipts
      .find((r) => r.action === action)
      .deltas.find(
        (d) => d.owner === owner.toBase58() && d.mint === mint.toBase58(),
      )?.delta ?? 0,
  );
assert.equal(delta("buy", wallet, state.quoteMint), -100000n);
assert.equal(delta("buy", wallet, state.baseMint), 494795601663n);
assert.equal(delta("collect", treasury, state.quoteMint), 800n);
assert.equal(delta("allocate", wallet, state.quoteMint), 400n);
assert.equal(delta("withdraw", wallet, state.quoteMint), 200n);
assert.equal(delta("sell", wallet, state.baseMint), -10000000000n);
assert.equal(delta("sell", wallet, state.quoteMint), 1980n);
// A different funded wallet cannot withdraw from this creator's treasury.
const other = new PublicKey(
  JSON.parse(readFileSync("../cash-access/lib/treasury/market.json")).creator,
);
const wrong = await program.methods
  .withdrawRetained(new anchor.BN(1))
  .accounts({
    treasury,
    creator: other,
    treasuryQuote: custody,
    creatorQuote: getAssociatedTokenAddressSync(
      state.quoteMint,
      other,
      false,
      TOKEN_2022_PROGRAM_ID,
    ),
    quoteMint: state.quoteMint,
    tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
  })
  .transaction();
wrong.feePayer = other;
wrong.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
const rejection = (
  await connection.simulateTransaction(
    new VersionedTransaction(wrong.compileMessage()),
    { sigVerify: false, commitment: "confirmed" },
  )
).value;
assert.ok(rejection.err);
assert.ok(rejection.logs.some((l) => l.includes("ConstraintHasOne")));
const evidence = {
  verifiedAt: new Date().toISOString(),
  network: "devnet",
  wallet: wallet.toBase58(),
  program: program.programId.toBase58(),
  pool: pool.toBase58(),
  treasury: treasury.toBase58(),
  baseMint: state.baseMint.toBase58(),
  quoteMint: state.quoteMint.toBase58(),
  balances: {
    claimed: "800",
    distributed: "400",
    retained: "400",
    withdrawn: "200",
    custody: "200",
  },
  checks: [
    "seven browser-signed operations confirmed",
    "creator and recipient match browser wallet",
    "all token movements reconcile",
    "initial supply minted only at creation",
    "treasury custody reconciles to retained minus withdrawn",
    "unauthorized creator withdrawal rejected by deployed program",
  ],
  receipts,
  unauthorizedWithdrawal: rejection.err,
};
writeFileSync(
  "../cash-access/evidence/creator-market-lifecycle.json",
  JSON.stringify(evidence, null, 2),
);
console.log({
  checks: evidence.checks,
  receipts: receipts.map((r) => ({ action: r.action, signature: r.signature })),
});
