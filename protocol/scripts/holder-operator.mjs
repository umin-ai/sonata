import {DynamicBondingCurveClient,getCurrentPoint} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {scanHolderAccounts} from "../../cash-access/lib/rewards/holder-scan.ts";
// Devnet-only creator-run operator. No web endpoint, remote signer or secret logging.
import {
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
import {
  holderShares,
  rewardBudget,
} from "../../cash-access/lib/rewards/holder-math.ts";
import { createRpcFetch } from "../../cash-access/lib/treasury/rpc-fetch.ts";
const c = new Connection("https://api.devnet.solana.com", {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
  fetch: createRpcFetch(async (input, init) => { const r = await fetch(input, init); if(r.status===429) console.error("Rate limited read:", JSON.parse(init.body).method); return r; }, { intervalMs: 1000 }),
});
if (
  (await c.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
)
  throw Error("Devnet only");
const key = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      readFileSync(process.env.STOCKROOM_OPERATOR_KEY ?? ".keys/deployer.json"),
    ),
  ),
);
const m = JSON.parse(
  readFileSync(
    process.env.STOCKROOM_MARKET_FILE ??
      "../cash-access/lib/treasury/market.json",
  ),
);
if (key.publicKey.toBase58() !== m.creator)
  throw Error("Operator must be the creator for this market.");
const pk = (s) => new PublicKey(s),
  bn = (n) => new anchor.BN(String(n));
const p = new anchor.Program(
    JSON.parse(readFileSync("sdk/idl/stockroom_rewards.json")),
    { connection: c },
  ),
  t = new anchor.Program(
    JSON.parse(readFileSync("sdk/idl/stockroom_treasury.json")),
    { connection: c },
  );
const dbc = JSON.parse(
  readFileSync("../cash-access/lib/treasury/dbc-addresses.json"),
);
const policy = PublicKey.findProgramAddressSync(
  [Buffer.from("holder-policy"), pk(m.treasury).toBuffer()],
  p.programId,
)[0];
const mint = pk(m.quoteMint),
  ata = (o) =>
    getAssociatedTokenAddressSync(mint, o, true, TOKEN_2022_PROGRAM_ID);
mkdirSync("artifacts/holder-rounds", { recursive: true });
const file = `artifacts/holder-rounds/${m.treasury}.json`,
  lock = file + ".lock";
const fd = openSync(lock, "wx", 0o600);
closeSync(fd);
const journal = existsSync(file)
  ? JSON.parse(readFileSync(file))
  : { network: "devnet", treasury: m.treasury, receipts: [], snapshots: [] };
const save = () => writeFileSync(file, JSON.stringify(journal, null, 2) + "\n");
async function reconcile() {
  if (!journal.pending) return;
  const { signature, blockhash, lastValidBlockHeight } = journal.pending;
  const status = (
    await c.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    })
  ).value[0];
  if (status?.err)
    throw Error(
      `Pending transaction failed: ${signature}. Inspect before continuing.`,
    );
  if (
    !status ||
    !["confirmed", "finalized"].includes(status.confirmationStatus)
  )
    throw Error(
      `Pending transaction not resolved: ${signature}. Do not re-fund.`,
    );
  journal.receipts.push(journal.pending);
  delete journal.pending;
  save();
}
async function send(label, ixs) {
  await reconcile();
  const latest = await c.getLatestBlockhash(),
    tx = new Transaction({ feePayer: key.publicKey, ...latest }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 650000 }),
      ...ixs,
    );
  const sim = await c.simulateTransaction(
    new VersionedTransaction(tx.compileMessage()),
    { sigVerify: false, commitment: "confirmed" },
  );
  if (sim.value.err)
    throw Error(`Simulation failed: ${sim.value.logs?.join("\n")}`);
  tx.sign(key);
  const raw = tx.serialize(),
    signature = anchor.utils.bytes.bs58.encode(tx.signature);
  journal.pending = {
    label,
    signature,
    ...latest,
    at: new Date().toISOString(),
  };
  save();
  await c.sendRawTransaction(raw, {
    maxRetries: 0,
    preflightCommitment: "confirmed",
  });
  const receipt = await c.confirmTransaction(
    { signature, ...latest },
    "confirmed",
  );
  if (receipt.value.err) throw Error("Transaction failed; inspect journal.");
  await reconcile();
  console.log(label, signature);
}
async function tick() {
  await reconcile();
  let cfg = await p.account.holderPolicy.fetchNullable(policy);
  if (!cfg) {
    if (!process.argv.includes("--enable-demo"))
      throw Error("Enable a holder policy in the app first.");
    await send("Enable 50% holder rewards / 60-second Devnet interval", [
      await p.methods
        .createPolicy(5000, bn(60))
        .accounts({
          creator: key.publicKey,
          treasury: pk(m.treasury),
          policy,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ]);
    cfg = await p.account.holderPolicy.fetch(policy);
  }
  // Resume previously funded rounds first, even if the policy is now paused.
  const rounds = (await p.account.holderRound.all()).filter((r) =>
    r.account.policy.equals(policy),
  );
  for (const r of rounds) {
    const ca = r.account.campaign,
      account = await p.account.campaign.fetch(ca);
    for (let i = 0; i < account.allocations.length; i++)
      if (!(account.claimedMask & (1 << i))) {
        const a = account.allocations[i];
        await send("Deliver holder payout", [
          createAssociatedTokenAccountIdempotentInstruction(
            key.publicKey,
            ata(a.recipient),
            a.recipient,
            mint,
            TOKEN_2022_PROGRAM_ID,
          ),
          await p.methods
            .deliver(i)
            .accounts({
              payer: key.publicKey,
              campaign: ca,
              escrow: ata(ca),
              mint,
              recipient: a.recipient,
              destination: ata(a.recipient),
              tokenProgram: TOKEN_2022_PROGRAM_ID,
            })
            .instruction(),
        ]);
      }
  }
  if (
    !cfg.shareBps ||
    Date.now() / 1000 <
      cfg.lastRoundAt.toNumber() + cfg.intervalSeconds.toNumber()
  )
    return;
  // Collection is permissionless; treasury allocation follows its existing onchain split.
  const coder = new anchor.BorshAccountsCoder(
    JSON.parse(readFileSync("../cash-access/lib/treasury/dbc.json")),
  );
  const poolRaw = await c.getAccountInfo(pk(m.pool));
  const decoded = coder.decode("virtualPool", poolRaw.data),
    pool = decoded.poolState ?? decoded;
  if (pool.isMigrated !== 0)
    throw Error("Migrated pool requires a separate collector.");
  if (BigInt(pool.partnerQuoteFee.toString()) > 0n)
    await send("Collect market fees", [
      await t.methods
        .claim()
        .accounts({
          vault: pk(m.vault),
          treasury: pk(m.treasury),
          poolAuthority: pk(dbc.poolAuthority),
          config: pk(m.config),
          pool: pk(m.pool),
          treasuryBase: pk(m.treasuryBase),
          treasuryQuote: pk(m.treasuryQuote),
          baseVault: pk(m.baseVault),
          quoteVault: pk(m.quoteVault),
          baseMint: pk(m.baseMint),
          quoteMint: mint,
          tokenBaseProgram: TOKEN_PROGRAM_ID,
          tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
          dbcEventAuthority: pk(dbc.eventAuthority),
          dbcProgram: pk(dbc.program),
        })
        .instruction(),
    ]);
  let state = await t.account.treasury.fetch(pk(m.treasury));
  if (
    state.totalClaimed
      .sub(state.totalDistributed)
      .sub(state.totalRetained)
      .gtn(0)
  )
    await send("Allocate collected fees", [
      await t.methods
        .distribute()
        .accounts({
          treasury: pk(m.treasury),
          treasuryQuote: pk(m.treasuryQuote),
          payoutQuote: pk(m.payoutQuote),
          quoteMint: mint,
          tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
        })
        .instruction(),
    ]);
  state = await t.account.treasury.fetch(pk(m.treasury));
  const budget = rewardBudget(
    BigInt(state.totalRetained.toString()),
    BigInt(cfg.checkpoint.toString()),
    BigInt(state.totalRetained.sub(state.totalWithdrawn).toString()),
    cfg.shareBps,
  );
  if (!budget) {
    console.log("Waiting for new fee revenue.");
    return;
  }
  const scan=await scanHolderAccounts(c,m.baseMint);
  const balances = scan.value
    .map(({ pubkey, account }) => unpackAccount(pubkey, account, scan.program))
    .filter(
      (a) =>
        a.mint.toBase58() === m.baseMint &&
        !a.isFrozen &&
        PublicKey.isOnCurve(a.owner.toBytes()),
    )
    .map((a) => ({ owner: a.owner.toBase58(), amount: a.amount.toString() }));
  const shares = holderShares(balances, budget, new Set([m.creator])),
    allocations = shares.filter((a) => BigInt(a.amount) > 0n);
  if (allocations.length > 8)
    throw Error(
      "More than eight payable holders. Fail closed; batching upgrade required.",
    );
  const doc = {
    treasury: m.treasury,
    policy: policy.toBase58(),
    checkpoint: cfg.checkpoint.toString(),
    slot: scan.context.slot,
    budget: budget.toString(),
    shares,
  };
  const hash = createHash("sha256").update(JSON.stringify(doc)).digest();
  journal.snapshots.push({ ...doc, hash: hash.toString("hex") });
  save();
  const nonce = bn(
      (BigInt(Date.now()) << 16n) + BigInt(Math.floor(Math.random() * 65536)),
    ),
    campaign = PublicKey.findProgramAddressSync(
      [
        Buffer.from("rewards"),
        key.publicKey.toBuffer(),
        nonce.toArrayLike(Buffer, "le", 8),
      ],
      p.programId,
    )[0],
    round = PublicKey.findProgramAddressSync(
      [Buffer.from("holder-round"), campaign.toBuffer()],
      p.programId,
    )[0];
  await send("Fund proportional holder round", [
    createAssociatedTokenAccountIdempotentInstruction(
      key.publicKey,
      ata(key.publicKey),
      key.publicKey,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
    await p.methods
      .fund(
        nonce,
        allocations.map((a) => ({
          recipient: pk(a.recipient),
          amount: bn(a.amount),
        })),
      )
      .accounts({
        creator: key.publicKey,
        treasury: pk(m.treasury),
        treasuryQuote: pk(m.treasuryQuote),
        creatorQuote: ata(key.publicKey),
        mint,
        campaign,
        escrow: ata(campaign),
        treasuryProgram: t.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    await p.methods
      .recordRound(bn(scan.context.slot), [...hash])
      .accounts({
        instructions: pk("Sysvar1nstructions1111111111111111111111111"),
        creator: key.publicKey,
        treasury: pk(m.treasury),
        policy,
        campaign,
        round,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
  ]);
  // Delivery resumes from the onchain claimed mask, including after a restart.
  for (let i = 0; i < allocations.length; i++) {
    const recipient = pk(allocations[i].recipient);
    await send("Deliver holder payout", [
      createAssociatedTokenAccountIdempotentInstruction(
        key.publicKey,
        ata(recipient),
        recipient,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
      await p.methods
        .deliver(i)
        .accounts({
          payer: key.publicKey,
          campaign,
          escrow: ata(campaign),
          mint,
          recipient,
          destination: ata(recipient),
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .instruction(),
    ]);
  }
}
const watch = process.argv.includes("--watch");
process.on("SIGINT", () => {
  try {
    unlinkSync(lock);
  } catch {}
  process.exit(0);
});
process.on("SIGTERM", () => {
  try {
    unlinkSync(lock);
  } catch {}
  process.exit(0);
});
try {
  if(process.argv.includes('--demo-trade')&&!journal.receipts.some(r=>r.label==='One-time Devnet proof trade')){
    await reconcile();
    const d=new DynamicBondingCurveClient(c,'confirmed'),pool=await d.state.getPool(pk(m.pool)),config=await d.state.getPoolConfig(pk(m.config)),amountIn=bn(1000000);
    const q=d.pool.swapQuote({virtualPool:pool,config,swapBaseForQuote:false,amountIn,slippageBps:50,hasReferral:false,eligibleForFirstSwapWithMinFee:false,currentPoint:await getCurrentPoint(c,config.activationType)});
    const tx=await d.pool.swap({owner:key.publicKey,pool:pk(m.pool),amountIn,minimumAmountOut:q.minimumAmountOut,swapBaseForQuote:false,referralTokenAccount:null});
    await send('One-time Devnet proof trade',tx.instructions);
  }
  do {
    try {
      await tick();
    } catch (e) {
      if (
        !watch ||
        journal.pending ||
        !/busy|429|fetch failed|timeout/i.test(e.message)
      )
        throw e;
      console.error("RPC unavailable; next cycle will retry reads.");
    }
    if (!watch) break;
    await new Promise((r) => setTimeout(r, 60000));
  } while (true);
} finally {
  if (existsSync(lock)) unlinkSync(lock);
}
