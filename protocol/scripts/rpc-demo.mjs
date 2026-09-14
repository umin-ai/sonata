// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  MINT_SIZE,
  ExtensionType,
  getMintLen,
  createInitializeMint2Instruction,
  createInitializeScaledUiAmountConfigInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
} from "@solana/spl-token";
import {
  createClient,
  CREDIT_ID,
  ORACLE_ID,
  DEVNET_GENESIS,
  positionAddress,
  U128_MAX,
} from "../sdk/client.mjs";
import { proveProgram } from "./program-proof.mjs";
const local = process.argv.includes("--local");
const rpc = local ? "http://127.0.0.1:18899" : "https://api.devnet.solana.com";
const connection = new Connection(rpc, "confirmed");
const genesis = await connection.getGenesisHash();
if (!local && genesis !== DEVNET_GENESIS)
  throw new Error("Refusing a network other than Solana Devnet");
if (
  local &&
  [
    DEVNET_GENESIS,
    "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNYk",
  ].includes(genesis)
)
  throw new Error("Local mode must use an isolated local validator");
const programProof = [];
for (const [id, name] of [
  [CREDIT_ID, "stockroom_credit"],
  [ORACLE_ID, "demo_oracle"],
])
  programProof.push(await proveProgram(connection, id, name));
const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(".keys/deployer.json"))),
);
if (local && (await connection.getBalance(admin.publicKey)) < 1_000_000_000) {
  const signature = await connection.requestAirdrop(
    admin.publicKey,
    2_000_000_000,
  );
  await connection.confirmTransaction(signature, "confirmed");
}
if ((await connection.getBalance(admin.publicKey)) < 100_000_000)
  throw new Error(
    `Need test SOL for demo setup at ${admin.publicKey}; refusing to use other wallets`,
  );
const run = `${local ? "localnet" : "devnet"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const privateDirectory = resolve(".keys", run);
mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
const keys = { admin };
for (const name of [
  "lender",
  "borrower",
  "liquidator",
  "stockMint",
  "cashMint",
  "oracleAccount",
]) {
  keys[name] = Keypair.generate();
  writeFileSync(
    resolve(privateDirectory, `${name}.json`),
    JSON.stringify([...keys[name].secretKey]),
    { mode: 0o600, flag: "wx" },
  );
}
const provider = new anchor.AnchorProvider(
  connection,
  new anchor.Wallet(admin),
  { commitment: "confirmed" },
);
const creditIdl = JSON.parse(readFileSync("target/idl/stockroom_credit.json"));
const oracleIdl = JSON.parse(readFileSync("target/idl/demo_oracle.json"));
const c = createClient(creditIdl, oracleIdl, provider, {
  admin: admin.publicKey,
  collateralMint: keys.stockMint.publicKey,
  debtMint: keys.cashMint.publicKey,
  oracleAccount: keys.oracleAccount.publicKey,
});
const evidence = {
  run,
  network: local ? "localnet" : "devnet",
  rpc,
  genesis,
  startedAt: new Date().toISOString(),
  testAssets: true,
  programProof,
  programs: { credit: CREDIT_ID.toBase58(), demoOracle: ORACLE_ID.toBase58() },
  binaries: Object.fromEntries(
    ["stockroom_credit", "demo_oracle"].map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(`target/deploy/${name}.so`))
        .digest("hex"),
    ]),
  ),
  accounts: {
    ...Object.fromEntries(
      Object.entries(keys).map(([name, key]) => [
        name,
        key.publicKey.toBase58(),
      ]),
    ),
    market: c.market.toBase58(),
    cashVault: c.cashVault.toBase58(),
    collateralVault: c.collateralVault.toBase58(),
  },
  steps: [],
};
mkdirSync("artifacts", { recursive: true });
const save = () =>
  writeFileSync(
    `artifacts/${run}.json`,
    JSON.stringify(evidence, null, 2) + "\n",
  );
save();
async function send(label, instructions, extra = []) {
  const ixs = (
    await Promise.all(
      Array.isArray(instructions) ? instructions : [instructions],
    )
  ).flat();
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: admin.publicKey,
    ...latest,
  }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs);
  const signers = [
    admin,
    ...extra.filter((key) => !key.publicKey.equals(admin.publicKey)),
  ];
  transaction.sign(...signers);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    { skipPreflight: false, maxRetries: 3 },
  );
  const confirmation = await connection.confirmTransaction(
    { ...latest, signature },
    "confirmed",
  );
  if (confirmation.value.err)
    throw new Error(`${label}: ${JSON.stringify(confirmation.value.err)}`);
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  evidence.steps.push({
    label,
    signature,
    slot: confirmation.context.slot,
    computeUnits: tx?.meta?.computeUnitsConsumed ?? null,
    feeLamports: tx?.meta?.fee ?? null,
    error: tx?.meta?.err ?? null,
  });
  save();
  console.log(`${label}: ${signature}`);
}
const CASH = 1_000_000n,
  STOCK = 100_000_000n;
const createMint = async (key, space, programId) =>
  SystemProgram.createAccount({
    fromPubkey: admin.publicKey,
    newAccountPubkey: key.publicKey,
    space,
    lamports: await connection.getMinimumBalanceForRentExemption(space),
    programId,
  });
await send(
  "Create demo quote mint",
  [
    await createMint(keys.cashMint, MINT_SIZE, TOKEN_PROGRAM_ID),
    createInitializeMint2Instruction(
      keys.cashMint.publicKey,
      6,
      admin.publicKey,
      null,
    ),
  ],
  [keys.cashMint],
);
await send(
  "Create demo stock mint",
  [
    await createMint(
      keys.stockMint,
      getMintLen([ExtensionType.ScaledUiAmountConfig]),
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeScaledUiAmountConfigInstruction(
      keys.stockMint.publicKey,
      admin.publicKey,
      1,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMint2Instruction(
      keys.stockMint.publicKey,
      8,
      admin.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID,
    ),
  ],
  [keys.stockMint],
);
for (const name of ["lender", "borrower", "liquidator"]) {
  const owner = keys[name].publicKey;
  await send(`Fund ${name} test accounts`, [
    SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: owner,
      lamports: 20_000_000,
    }),
    createAssociatedTokenAccountIdempotentInstruction(
      admin.publicKey,
      c.cash(owner).userCash,
      owner,
      keys.cashMint.publicKey,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      admin.publicKey,
      c.collateral(owner).userStock,
      owner,
      keys.stockMint.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ),
    createMintToCheckedInstruction(
      keys.cashMint.publicKey,
      c.cash(owner).userCash,
      admin.publicKey,
      (name === "borrower" ? 50n : 10_000n) * CASH,
      6,
    ),
    createMintToCheckedInstruction(
      keys.stockMint.publicKey,
      c.collateral(owner).userStock,
      admin.publicKey,
      20n * STOCK,
      8,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  ]);
}
await send("Initialize demo oracle", c.initializeOracle(), [
  keys.oracleAccount,
]);
await send("Initialize Stockroom market", c.initializeMarket());
for (const name of ["lender", "borrower", "liquidator"])
  await send(
    `Initialize ${name} position`,
    c.initializePosition(keys[name].publicKey),
    [keys[name]],
  );
await send(
  "Lender supplies 5,000 demo USD",
  c.supply(keys.lender.publicKey, 5_000n * CASH),
  [keys.lender],
);
await send(
  "Borrower deposits 10 demo stocks",
  c.depositCollateral(keys.borrower.publicKey, 10n * STOCK),
  [keys.borrower],
);
await send("Refresh demo price", c.publish(200n * CASH));
await send(
  "Borrower receives 500 demo USD",
  c.borrow(keys.borrower.publicKey, 500n * CASH),
  [keys.borrower],
);
const borrowerBalance = await connection.getTokenAccountBalance(
  c.cash(keys.borrower.publicKey).userCash,
);
assert.equal(borrowerBalance.value.amount, String(550n * CASH));
await send(
  "Borrower repays debt and elapsed interest",
  c.repay(keys.borrower.publicKey, U128_MAX, 510n * CASH),
  [keys.borrower],
);
await send(
  "Borrower releases all collateral",
  c.withdrawCollateral(keys.borrower.publicKey, 10n * STOCK),
  [keys.borrower],
);
await send(
  "Lender redeems available capital and interest",
  c.redeem(keys.lender.publicKey, U128_MAX, 5_000n * CASH),
  [keys.lender],
);
// A second independently funded loan proves liquidation and loss accounting on the same network.
await send(
  "Lender supplies liquidation test liquidity",
  c.supply(keys.lender.publicKey, 5_000n * CASH),
  [keys.lender],
);
await send(
  "Borrower posts liquidation test collateral",
  c.depositCollateral(keys.borrower.publicKey, 10n * STOCK),
  [keys.borrower],
);
await send("Refresh opening quote", c.publish(200n * CASH));
await send(
  "Borrower receives 900 demo USD",
  c.borrow(keys.borrower.publicKey, 900n * CASH),
  [keys.borrower],
);
await send("Demo price shock to 50 USD per raw stock", c.publish(50n * CASH));
await send(
  "Liquidator pays and seizes exhausted collateral",
  c.liquidate(
    keys.liquidator.publicKey,
    keys.borrower.publicKey,
    10n * STOCK,
    500n * CASH,
  ),
  [keys.liquidator],
);
const lossState = await c.credit.account.market.fetch(c.market);
assert.equal(lossState.debtAssets.toString(), "0");
assert.equal(lossState.debtShares.toString(), "0");
assert(BigInt(lossState.cash.toString()) < 4_600n * CASH);
evidence.lossScenario = {
  remainingLenderNavAtoms: lossState.cash.toString(),
  debtAssetsAtoms: lossState.debtAssets.toString(),
};
await send(
  "Lender redeems reduced NAV after bad debt",
  c.redeem(keys.lender.publicKey),
  [keys.lender],
);
const market = await c.credit.account.market.fetch(c.market);
const borrower = await c.credit.account.position.fetch(
  positionAddress(c.market, keys.borrower.publicKey),
);
assert.equal(borrower.collateral.toString(), "0");
assert.equal(borrower.debtShares.toString(), "0");
assert.equal(market.supplyShares.toString(), "0");
evidence.completedAt = new Date().toISOString();
evidence.result = "PASS";
evidence.finalState = {
  cashAtoms: market.cash.toString(),
  debtAssetsAtoms: market.debtAssets.toString(),
  supplyShares: market.supplyShares.toString(),
  debtShares: market.debtShares.toString(),
  borrowerCollateralAtoms: borrower.collateral.toString(),
};
save();
console.log(
  `PASS: full custody/repayment and liquidation lifecycle on ${evidence.network}. Evidence: artifacts/${run}.json`,
);
