// SPDX-License-Identifier: GPL-3.0-or-later
// Devnet only. Reuses the disposable demo issuer, never the upgrade authority.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  TYPE_SIZE,
  LENGTH_SIZE,
  createInitializeMint2Instruction,
  createInitializeScaledUiAmountConfigInstruction,
  createInitializeMetadataPointerInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
  getMint,
  getTokenMetadata,
} from "@solana/spl-token";
import {
  pack,
  createInitializeInstruction,
  createUpdateFieldInstruction,
} from "@solana/spl-token-metadata";
import { createClient, DEVNET_GENESIS } from "../sdk/client.mjs";
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
if ((await connection.getGenesisHash()) !== DEVNET_GENESIS)
  throw Error("Devnet required");
const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(".keys/app-demo/authority.json"))),
);
const legacy = JSON.parse(readFileSync("artifacts/app-demo.json"));
const provider = new anchor.AnchorProvider(
  connection,
  new anchor.Wallet(admin),
  { commitment: "confirmed" },
);
const idl = JSON.parse(readFileSync("sdk/idl/stockroom_credit.json"));
const oracleIdl = JSON.parse(readFileSync("sdk/idl/demo_oracle.json"));
const output = "artifacts/mock-markets.json";
const registry = existsSync(output)
  ? JSON.parse(readFileSync(output))
  : {
      network: "solana:devnet",
      genesis: DEVNET_GENESIS,
      createdAt: new Date().toISOString(),
      markets: [],
    };
const save = () =>
  writeFileSync(output, JSON.stringify(registry, null, 2) + "\n");
function key(name) {
  const path = `.keys/app-demo/${name}.json`;
  if (existsSync(path))
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(path))),
    );
  const k = Keypair.generate();
  writeFileSync(path, JSON.stringify([...k.secretKey]), {
    mode: 0o600,
    flag: "wx",
  });
  return k;
}
async function send(market, label, ixs, signers = [admin]) {
  let step = market.steps.find((s) => s.label === label);
  if (step?.status === "finalized") return;
  if (step) {
    const s = (
      await connection.getSignatureStatuses([step.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (s?.err)
      throw Error(
        `Previously submitted ${label} failed; inspect receipt before retrying`,
      );
    if (s?.confirmationStatus === "finalized") {
      step.status = "finalized";
      save();
      return;
    }
    if (!s)
      throw Error(
        `Resolve pending receipt ${step.signature} before retrying ${label}`,
      );
  } else {
    const block = await connection.getLatestBlockhash();
    const tx = new Transaction({ feePayer: admin.publicKey, ...block }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ...(await Promise.all(ixs)),
    );
    tx.sign(...signers);
    // Persist identity before broadcast so a timeout cannot silently duplicate issuance.
    const bs58 = (await import("bs58")).default;
    step = {
      label,
      signature: bs58.encode(tx.signature),
      status: "pending",
      lastValidBlockHeight: block.lastValidBlockHeight,
    };
    market.steps.push(step);
    save();
    await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  }
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = (await connection.getSignatureStatuses([step.signature]))
      .value[0];
    if (s?.err) throw Error(JSON.stringify(s.err));
    if (s?.confirmationStatus === "finalized") {
      step.status = "finalized";
      step.slot = s.slot;
      save();
      console.log(market.symbol, label, step.signature);
      return;
    }
  }
  throw Error(`Pending ${step.signature}; rerun to resolve`);
}
for (const [symbol, name, demoPrice] of [
  ["MockSPYx", "S&P 500 ETF", 600],
  ["MockNVDAx", "NVIDIA", 180],
  ["MockQQQx", "Nasdaq-100 ETF", 500],
  ["MockTSLAx", "Tesla", 350],
]) {
  const stock = key(`${symbol}-mint`),
    oracle = key(`${symbol}-oracle`);
  const c = createClient(idl, oracleIdl, provider, {
    admin: admin.publicKey,
    collateralMint: stock.publicKey,
    debtMint: new PublicKey(legacy.debtMint),
    oracleAccount: oracle.publicKey,
  });
  let m = registry.markets.find((m) => m.symbol === symbol);
  if (!m) {
    m = {
      ...legacy,
      id: symbol,
      symbol,
      name,
      demoPrice,
      collateralMint: stock.publicKey.toBase58(),
      oracleAccount: oracle.publicKey.toBase58(),
      market: c.market.toBase58(),
      cashVault: c.cashVault.toBase58(),
      collateralVault: c.collateralVault.toBase58(),
      createdAt: new Date().toISOString(),
      aprBps: 500,
      openingLtvBps: 5000,
      liquidationLtvBps: 6500,
      bonusBps: 500,
      multiplier: 1,
      priceType: "fixed-test-fixture",
      steps: [],
    };
    registry.markets.push(m);
    save();
  }
  const metadata = {
    updateAuthority: admin.publicKey,
    mint: stock.publicKey,
    name: `Stockroom ${symbol} (Devnet)`,
    symbol,
    uri: "",
    additionalMetadata: [
      [
        "description",
        "Unbacked Devnet test token. Not an xStock, equity, or redeemable asset.",
      ],
    ],
  };
  const space = getMintLen([
    ExtensionType.ScaledUiAmountConfig,
    ExtensionType.MetadataPointer,
  ]);
  await send(
    m,
    "Create mint and onchain metadata",
    [
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: stock.publicKey,
        space,
        lamports: await connection.getMinimumBalanceForRentExemption(
          space + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length,
        ),
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeScaledUiAmountConfigInstruction(
        stock.publicKey,
        admin.publicKey,
        1,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMetadataPointerInstruction(
        stock.publicKey,
        admin.publicKey,
        stock.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMint2Instruction(
        stock.publicKey,
        8,
        admin.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: stock.publicKey,
        updateAuthority: admin.publicKey,
        mint: stock.publicKey,
        mintAuthority: admin.publicKey,
        name: metadata.name,
        symbol,
        uri: "",
      }),
      createUpdateFieldInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: stock.publicKey,
        updateAuthority: admin.publicKey,
        field: "description",
        value: metadata.additionalMetadata[0][1],
      }),
    ],
    [admin, stock],
  );
  await send(
    m,
    "Initialize fixed test price feed",
    [c.initializeOracle(BigInt(demoPrice) * 1000000n)],
    [admin, oracle],
  );
  await send(m, "Create isolated credit market", [c.initializeMarket()]);
  await send(m, "Issue 10000 mock stocks to issuer inventory", [
    createAssociatedTokenAccountIdempotentInstruction(
      admin.publicKey,
      c.collateral(admin.publicKey).userStock,
      admin.publicKey,
      stock.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ),
    createMintToCheckedInstruction(
      stock.publicKey,
      c.collateral(admin.publicKey).userStock,
      admin.publicKey,
      1000000000000n,
      8,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  ]);
  await send(m, "Seed 25000 demo USD lending liquidity", [
    createMintToCheckedInstruction(
      new PublicKey(m.debtMint),
      c.cash(admin.publicKey).userCash,
      admin.publicKey,
      25000000000n,
      6,
    ),
    c.initializePosition(admin.publicKey),
    c.supply(admin.publicKey, 25000000000n),
  ]);
  const mint = await getMint(
    connection,
    stock.publicKey,
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
  const meta = await getTokenMetadata(connection, stock.publicKey);
  if (
    mint.decimals !== 8 ||
    meta.symbol !== symbol ||
    !mint.mintAuthority.equals(admin.publicKey)
  )
    throw Error("Mint verification failed");
  const state = await c.credit.account.market.fetch(c.market);
  if (
    !state.collateralMint.equals(stock.publicKey) ||
    !state.oracle.equals(oracle.publicKey)
  )
    throw Error("Market verification failed");
  m.verifiedAt = new Date().toISOString();
  save();
}
console.log(
  JSON.stringify({
    markets: registry.markets.map((m) => ({
      symbol: m.symbol,
      market: m.market,
    })),
    remainingTestSOL: (await connection.getBalance(admin.publicKey)) / 1e9,
  }),
);
