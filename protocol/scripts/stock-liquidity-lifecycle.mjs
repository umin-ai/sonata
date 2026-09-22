// Devnet only. Real Meteora positions; no synthetic ledger or invented APY.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  createMintToCheckedInstruction,
} from "@solana/spl-token";
import {
  CpAmm,
  CP_AMM_PROGRAM_ID,
  CollectFeeMode,
  BaseFeeMode,
  getBaseFeeParams,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
  derivePositionAddress,
  derivePositionNftAccount,
  SwapMode,
} from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import bs58 from "bs58";
let rpcQueue = Promise.resolve();
const pacedFetch = (...args) => {
  const task = rpcQueue.then(async () => {
    await new Promise((r) => setTimeout(r, 350));
    for (let i = 0; i < 5; i++) {
      const response = await fetch(...args);
      if (response.status !== 429) return response;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
    throw Error("RPC rate limited; rerun to resume confirmed steps.");
  });
  rpcQueue = task.catch(() => {});
  return task;
};
const c = new Connection(process.env.STOCKROOM_DEVNET_RPC || "https://api.devnet.solana.com", {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
  fetch: pacedFetch,
});
assert.equal(
  await c.getGenesisHash(),
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
);
const id=process.argv[2];
if(!['spy','nvda','qqq','tsla'].includes(id))throw Error('Choose spy, nvda, qqq or tsla');
const stock=JSON.parse(readFileSync('artifacts/mock-markets.json')).markets.find(x=>x.id.toLowerCase()==='mock'+id+'x');
const m={baseMint:stock.debtMint,quoteMint:stock.collateralMint,pool:stock.market};
const amm=new CpAmm(c);
const key = (name) => {
  const path = `.keys/stock-lp-${id}-${name}.json`;
  if (!existsSync(path))
    writeFileSync(path, JSON.stringify([...Keypair.generate().secretKey]), {
      mode: 0o600,
    });
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path))));
};
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/app-demo/authority.json")))),
  alice = key("lp-alice"),
  bob = key("lp-bob"),
  trader = key("lp-trader"),
  seedNft = key("lp-seed-nft"),
  aliceNft = key("lp-alice-nft"),
  bobNft = key("lp-bob-nft");
const a = new PublicKey(m.baseMint),
  b = new PublicKey(m.quoteMint),
  bn = (x) => new BN(String(x));
const path = `artifacts/stock-${id}-liquidity-market.json`;
const evidencePath = `artifacts/stock-${id}-liquidity-lifecycle.json`;
if (existsSync(evidencePath) && JSON.parse(readFileSync(evidencePath)).complete)
  throw Error(
    "Lifecycle already complete. Use the read-only verifier; do not replay funding/trades.",
  );
const evidence = existsSync(evidencePath)
  ? JSON.parse(readFileSync(evidencePath))
  : {
      network: "devnet",
      sdk: "@meteora-ag/cp-amm-sdk@1.4.8",
      startedAt: new Date().toISOString(),
      receipts: [],
      checks: {},
    };
const save = () =>
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
if(evidence.pending){
 const p=evidence.pending;
 const status=(await c.getSignatureStatuses([p.signature],{searchTransactionHistory:true})).value[0];
 if(status?.err)throw Error('Prior transaction failed; inspect journal before retrying.');
 if(!status||!['confirmed','finalized'].includes(status.confirmationStatus))throw Error('Prior transaction unresolved; no new writes sent.');
 evidence.receipts.push({label:p.label,signature:p.signature,signer:p.signer});delete evidence.pending;save();
}
async function send(label, tx, signers) {
  if (evidence.receipts.some((r) => r.label === label)) return;
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 }),
  );
  const latest = await c.getLatestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = latest.blockhash;
  const sim = await c.simulateTransaction(
    new VersionedTransaction(tx.compileMessage()),
    { sigVerify: false },
  );
  if (sim.value.err)
    throw Error(
      label +
        ": " +
        JSON.stringify(sim.value.err) +
        " " +
        sim.value.logs?.slice(-10).join("\n"),
    );
  tx.sign(...signers);
  const signature=bs58.encode(tx.signature);
  evidence.pending={label,signature,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,signer:signers[0].publicKey.toBase58()};save();
  await c.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:0});
  const confirmed=await c.confirmTransaction({signature,...latest},'confirmed');
  if(confirmed.value.err)throw Error('Transaction failed: '+JSON.stringify(confirmed.value.err));
  delete evidence.pending;
  evidence.receipts.push({
    label,
    signature,
    signer: signers[0].publicKey.toBase58(),
  });
  save();
  console.log(label, signature);
}
async function rejection(label, tx, owner) {
  tx.feePayer = owner;
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  const s = await c.simulateTransaction(
    new VersionedTransaction(tx.compileMessage()),
    { sigVerify: false },
  );
  assert(s.value.err, label + " must reject");
  evidence.checks[label] = {
    error: s.value.err,
    logs: s.value.logs
      ?.filter((l) => /Error|failed|constraint|authority/i.test(l))
      .slice(-5),
  };
  save();
}
for(const [mint,program,raw,decimals,label] of [[a,TOKEN_PROGRAM_ID,BigInt(stock.demoPrice)*100000000n,6,'issue-test-cash'],[b,TOKEN_2022_PROGRAM_ID,10000000000n,8,'issue-test-stock']]){
 const dest=getAssociatedTokenAddressSync(mint,payer.publicKey,false,program);
 await send(label,new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,dest,payer.publicKey,mint,program),createMintToCheckedInstruction(mint,dest,payer.publicKey,raw,decimals,[],program)),[payer]);
}
for (const [person, rawA, rawB, label] of [
  [alice, BigInt(stock.demoPrice)*2000000n, 200000000n, "fund-alice"],
  [bob, BigInt(stock.demoPrice)*3000000n, 300000000n, "fund-bob"],
  [trader, BigInt(stock.demoPrice)*2000000n, 200000000n, "fund-trader"],
]) {
  if (evidence.receipts.some((r) => r.label === label)) continue;
  const tx = new Transaction();
  const sol = await c.getBalance(person.publicKey);
  if (sol < 50000000)
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: person.publicKey,
        lamports: 50000000 - sol,
      }),
    );
  for (const [mint, program, amount, decimals] of [
    [a, TOKEN_PROGRAM_ID, rawA, 6],
    [b, TOKEN_2022_PROGRAM_ID, rawB, 8],
  ]) {
    const dest = getAssociatedTokenAddressSync(
      mint,
      person.publicKey,
      false,
      program,
    );
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        dest,
        person.publicKey,
        mint,
        program,
      ),
      createTransferCheckedInstruction(
        getAssociatedTokenAddressSync(mint, payer.publicKey, false, program),
        mint,
        dest,
        payer.publicKey,
        amount,
        decimals,
        [],
        program,
      ),
    );
  }
  await send(label, tx, [payer]);
}
if (!existsSync(path)) {
  const tokenAAmount = bn(BigInt(stock.demoPrice)*10000000n),
    tokenBAmount = bn("1000000000");
  const creation = amm.preparePoolCreationParams({
    tokenAAmount,
    tokenBAmount,
    minSqrtPrice: MIN_SQRT_PRICE,
    maxSqrtPrice: MAX_SQRT_PRICE,
    collectFeeMode: CollectFeeMode.Compounding,
  });
  const result = await amm.createCustomPool({
    payer: payer.publicKey,
    creator: payer.publicKey,
    positionNft: seedNft.publicKey,
    tokenAMint: a,
    tokenBMint: b,
    tokenAAmount,
    tokenBAmount,
    sqrtMinPrice: MIN_SQRT_PRICE,
    sqrtMaxPrice: MAX_SQRT_PRICE,
    liquidityDelta: creation.liquidityDelta,
    initSqrtPrice: creation.initSqrtPrice,
    poolFees: {
      baseFee: getBaseFeeParams({
        baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
        feeTimeSchedulerParam: {
          startingFeeBps: 100,
          endingFeeBps: 100,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      }),
      compoundingFeeBps: 10000,
      padding: 0,
      dynamicFee: null,
    },
    hasAlphaVault: false,
    activationType: 1,
    collectFeeMode: CollectFeeMode.Compounding,
    activationPoint: null,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_2022_PROGRAM_ID,
  });
  await send("create-pool", result.tx, [payer, seedNft]);
  writeFileSync(
    path,
    JSON.stringify(
      {
        network: "devnet",
        programId: CP_AMM_PROGRAM_ID.toBase58(),
        pool: result.pool.toBase58(),
        seedPosition: result.position.toBase58(),
        tokenAMint: a.toBase58(),
        tokenBMint: b.toBase58(),
        symbolA: "MockUSDC",
        symbolB: stock.symbol,
        decimalsA: 6,
        decimalsB: 8,
        tokenAProgram: TOKEN_PROGRAM_ID.toBase58(),
        tokenBProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
        sourceMarket: m.pool,
        feeBps: 100,
        compoundingFeeBps: 10000,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
}
const manifest = JSON.parse(readFileSync(path)),
  pool = new PublicKey(manifest.pool);
evidence.pool = manifest;
evidence.wallets = {
  alice: alice.publicKey.toBase58(),
  bob: bob.publicKey.toBase58(),
  trader: trader.publicKey.toBase58(),
  seed: payer.publicKey.toBase58(),
};
save();
const state = () => amm.fetchPoolState(pool);
const fields = (s) => ({
  pool,
  tokenAMint: a,
  tokenBMint: b,
  tokenAVault: s.tokenAVault,
  tokenBVault: s.tokenBVault,
  tokenAProgram: TOKEN_PROGRAM_ID,
  tokenBProgram: TOKEN_2022_PROGRAM_ID,
});
const qfields = (s) => ({
  sqrtPrice: s.sqrtPrice,
  minSqrtPrice: s.sqrtMinPrice,
  maxSqrtPrice: s.sqrtMaxPrice,
  collectFeeMode: s.collectFeeMode,
  tokenAAmount: s.tokenAAmount,
  tokenBAmount: s.tokenBAmount,
  liquidity: s.liquidity,
});
const snap = async () => {
  const s = await state();
  return {
    a: s.tokenAAmount.toString(),
    b: s.tokenBAmount.toString(),
    liquidity: s.liquidity.toString(),
    lpFeeB: s.metrics.totalLpBFee.toString(),
    protocolFeeB: s.metrics.totalProtocolBFee.toString(),
    feeMode: s.collectFeeMode,
    compoundBps: s.poolFees.compoundingFeeBps,
  };
};
for (const [owner, nft, amount, label] of [
  [alice, aliceNft, String(BigInt(stock.demoPrice)*1000000n), "deposit-alice"],
  [bob, bobNft, String(BigInt(stock.demoPrice)*2000000n), "deposit-bob"],
]) {
  if (evidence.receipts.some((r) => r.label === label)) continue;
  const s = await state(),
    q = amm.getDepositQuote({
      ...qfields(s),
      inAmount: bn(amount),
      isTokenA: true,
    });
  const tx = await amm.createPositionAndAddLiquidity({
    owner: owner.publicKey,
    ...fields(s),
    positionNft: nft.publicKey,
    liquidityDelta: q.liquidityDelta,
    maxAmountTokenA: bn(amount),
    maxAmountTokenB: q.outputAmount,
    tokenAAmountThreshold: bn(amount),
    tokenBAmountThreshold: q.outputAmount,
  });
  await send(label, tx, [owner, nft]);
  const p = await amm.fetchPositionState(derivePositionAddress(nft.publicKey));
  assert.equal(p.unlockedLiquidity.toString(), q.liquidityDelta.toString());
  evidence.checks[label] = {
    position: derivePositionAddress(nft.publicKey).toBase58(),
    liquidity: q.liquidityDelta.toString(),
    a: amount,
    b: q.outputAmount.toString(),
  };
  save();
}
for (const [nft, label] of [
  [aliceNft, "deposit-alice"],
  [bobNft, "deposit-bob"],
]) {
  if (!evidence.checks[label]) {
    const p = await amm.fetchPositionState(
      derivePositionAddress(nft.publicKey),
    );
    assert(p.unlockedLiquidity.gtn(0));
    evidence.checks[label] = {
      position: derivePositionAddress(nft.publicKey).toBase58(),
      liquidity: p.unlockedLiquidity.toString(),
    };
    save();
  }
}
if (!evidence.beforeTrade) {
  evidence.beforeTrade = await snap();
  save();
}
if (!evidence.receipts.some((r) => r.label === "independent-trade")) {
  const s = await state();
  const slot = await c.getSlot(),
    now = await c.getBlockTime(slot);
  const quote = amm.getQuote2({
    inputTokenMint: a,
    slippage: 0.5,
    currentPoint: bn(now),
    poolState: s,
    tokenADecimal: 6,
    tokenBDecimal: 8,
    hasReferral: false,
    swapMode: SwapMode.ExactIn,
    amountIn: bn(String(BigInt(stock.demoPrice)*100000n)),
  });
  assert(quote.compoundingFee.gtn(0));
  assert(quote.claimingFee.isZero());
  evidence.tradeQuote = {
    input: String(BigInt(stock.demoPrice)*100000n),
    output: quote.outputAmount.toString(),
    minimum: quote.minimumAmountOut.toString(),
    compounded: quote.compoundingFee.toString(),
    protocolFee: quote.protocolFee.toString(),
  };
  save();
  await send(
    "independent-trade",
    await amm.swap({
      payer: trader.publicKey,
      ...fields(s),
      inputTokenMint: a,
      outputTokenMint: b,
      amountIn: bn(String(BigInt(stock.demoPrice)*100000n)),
      minimumAmountOut: quote.minimumAmountOut,
      referralTokenAccount: null,
      poolState: s,
    }),
    [trader],
  );
}
if (!evidence.afterTrade) {
  evidence.afterTrade = await snap();
  const before = evidence.beforeTrade,
    after = evidence.afterTrade;
  assert.equal(before.liquidity, after.liquidity);
  assert(BigInt(after.lpFeeB) > BigInt(before.lpFeeB));
  assert(
    BigInt(after.a) * BigInt(after.b) > BigInt(before.a) * BigInt(before.b),
  );
  assert.equal(
    BigInt(after.b),
    BigInt(before.b) -
      BigInt(evidence.tradeQuote.output) -
      BigInt(evidence.tradeQuote.protocolFee),
  );
  evidence.checks.nativeCompounding = true;
  save();
}
const withdrawTx = async (owner, nft, portion = 10000, override = {}) => {
  const s = await state(),
    position = derivePositionAddress(nft.publicKey),
    p = await amm.fetchPositionState(position),
    liquidityDelta = p.unlockedLiquidity.muln(portion).divn(10000);
  const q = amm.getWithdrawQuote({ ...qfields(s), liquidityDelta });
  const params = {
    owner: owner.publicKey,
    ...fields(s),
    position,
    positionNftAccount: derivePositionNftAccount(nft.publicKey),
    liquidityDelta,
    tokenAAmountThreshold: q.outAmountA.muln(9950).divn(10000),
    tokenBAmountThreshold: q.outAmountB.muln(9950).divn(10000),
    vestings: [],
    currentPoint: bn(0),
    ...override,
  };
  return { tx: await amm.removeLiquidity(params), q, liquidityDelta };
};
if (!evidence.checks.unauthorizedWithdrawal) {
  const { tx } = await withdrawTx(trader, aliceNft, 5000);
  await rejection("unauthorizedWithdrawal", tx, trader.publicKey);
}
if (!evidence.checks.withdrawSlippage) {
  const { tx } = await withdrawTx(alice, aliceNft, 5000, {
    tokenAAmountThreshold: bn("18446744073709551615"),
  });
  await rejection("withdrawSlippage", tx, alice.publicKey);
}
if (!evidence.checks.overWithdrawal) {
  const { tx } = await withdrawTx(alice, aliceNft, 10000, {
    liquidityDelta: bn("340282366920938463463374607431768211455"),
  });
  await rejection("overWithdrawal", tx, alice.publicKey);
}
for (const [owner, nft, portion, label] of [
  [alice, aliceNft, 5000, "alice-partial-exit"],
  [alice, aliceNft, 10000, "alice-full-exit"],
  [bob, bobNft, 10000, "bob-full-exit"],
]) {
  if (evidence.receipts.some((r) => r.label === label)) continue;
  const balances = async () =>
    Promise.all(
      [
        [a, TOKEN_PROGRAM_ID],
        [b, TOKEN_2022_PROGRAM_ID],
      ].map(
        async ([mint, program]) =>
          (
            await getAccount(
              c,
              getAssociatedTokenAddressSync(
                mint,
                owner.publicKey,
                false,
                program,
              ),
              "confirmed",
              program,
            )
          ).amount,
      ),
    );
  const before = await balances(),
    { tx, q, liquidityDelta } = await withdrawTx(owner, nft, portion);
  await send(label, tx, [owner]);
  const after = await balances();
  assert.equal(after[0] - before[0], BigInt(q.outAmountA.toString()));
  assert.equal(after[1] - before[1], BigInt(q.outAmountB.toString()));
  evidence.checks[label] = {
    withdrawnLiquidity: liquidityDelta.toString(),
    aReceived: (after[0] - before[0]).toString(),
    bReceived: (after[1] - before[1]).toString(),
  };
  save();
}
for (const nft of [aliceNft, bobNft]) {
  const p = await amm.fetchPositionState(derivePositionAddress(nft.publicKey));
  assert(p.unlockedLiquidity.isZero());
  assert(p.permanentLockedLiquidity.isZero());
  assert(p.vestedLiquidity.isZero());
}
evidence.checks.bothDepositorsExited = true;
evidence.final = await snap();
evidence.complete = true;
evidence.finishedAt = new Date().toISOString();
save();
console.log("COMPLETE", evidence.checks);

const registryPath='../cash-access/lib/liquidity/stock-markets.json';
const registry=JSON.parse(readFileSync(registryPath));
const row={...manifest,id};
writeFileSync(registryPath,JSON.stringify([...registry.filter(x=>x.id!==id),row],null,2)+'\n');
