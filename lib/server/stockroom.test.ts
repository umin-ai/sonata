import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
} from "@solana/spl-token";
import { createClient } from "../stockroom/client.mjs";
import config from "../stockroom/deployment.json";
import creditIdl from "../stockroom/idl/stockroom_credit.json";
import oracleIdl from "../stockroom/idl/demo_oracle.json";
import { verifySponsor } from "./stockroom";
const owner = Keypair.generate().publicKey,
  admin = new PublicKey(config.admin),
  blockhash = Keypair.generate().publicKey.toBase58();
const c = createClient(
  creditIdl,
  oracleIdl,
  { connection: new Connection("https://api.devnet.solana.com") },
  {
    admin,
    collateralMint: new PublicKey(config.collateralMint),
    debtMint: new PublicKey(config.debtMint),
    oracleAccount: new PublicKey(config.oracleAccount),
  },
);
const compute = () =>
  ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 });
const encoded = (tx: Transaction) =>
  tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
async function pack(selected = c, selectedConfig = config) {
  return new Transaction({ feePayer: admin, recentBlockhash: blockhash }).add(
    compute(),
    SystemProgram.transfer({
      fromPubkey: admin,
      toPubkey: owner,
      lamports: 5000000,
    }),
    createAssociatedTokenAccountIdempotentInstruction(
      admin,
      selected.cash(owner).userCash,
      owner,
      new PublicKey(selectedConfig.debtMint),
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      admin,
      selected.collateral(owner).userStock,
      owner,
      new PublicKey(selectedConfig.collateralMint),
      TOKEN_2022_PROGRAM_ID,
    ),
    createMintToCheckedInstruction(
      new PublicKey(selectedConfig.debtMint),
      selected.cash(owner).userCash,
      admin,
      1000000000n,
      6,
    ),
    createMintToCheckedInstruction(
      new PublicKey(selectedConfig.collateralMint),
      selected.collateral(owner).userStock,
      admin,
      2500000000n,
      8,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
    await selected.initializePosition(owner),
  );
}
test("only the exact starter pack is eligible for a sponsor signature", async () => {
  const tx = await pack();
  await verifySponsor({
    wallet: owner.toBase58(),
    kind: "faucet",
    transaction: encoded(tx),
  });
  tx.instructions[1] = SystemProgram.transfer({
    fromPubkey: admin,
    toPubkey: owner,
    lamports: 5000001,
  });
  await assert.rejects(
    verifySponsor({
      wallet: owner.toBase58(),
      kind: "faucet",
      transaction: encoded(tx),
    }),
    /fixed starter pack/,
  );
  const changed = await pack();
  changed.instructions.pop();
  await assert.rejects(
    verifySponsor({
      wallet: owner.toBase58(),
      kind: "faucet",
      transaction: encoded(changed),
    }),
  );
});
test("oracle sponsorship cannot authorize a transfer or change the test price", async () => {
  const tx = new Transaction({
    feePayer: owner,
    recentBlockhash: blockhash,
  }).add(
    compute(),
    await c.publish(200000000n),
    await c.depositCollateral(owner, 800000000n),
    await c.borrow(owner, 500000000n),
  );
  await verifySponsor({
    wallet: owner.toBase58(),
    kind: "open",
    transaction: encoded(tx),
  });
  tx.instructions[1] = await c.publish(1n);
  await assert.rejects(
    verifySponsor({
      wallet: owner.toBase58(),
      kind: "open",
      transaction: encoded(tx),
    }),
    /fixed demo price/,
  );
  tx.instructions[1] = await c.publish(200000000n);
  tx.instructions[2] = SystemProgram.transfer({
    fromPubkey: admin,
    toPubkey: owner,
    lamports: 1,
  });
  await assert.rejects(
    verifySponsor({
      wallet: owner.toBase58(),
      kind: "open",
      transaction: encoded(tx),
    }),
  );
});
test("a caller cannot charge the oracle authority transaction fees", async () => {
  const tx = new Transaction({
    feePayer: admin,
    recentBlockhash: blockhash,
  }).add(
    compute(),
    await c.publish(200000000n),
    await c.borrow(owner, 500000000n),
  );
  await assert.rejects(
    verifySponsor({
      wallet: owner.toBase58(),
      kind: "borrow",
      transaction: encoded(tx),
    }),
    /Unexpected sponsored/,
  );
});

test("each mock market sponsors only its own fixed oracle and collateral accounts", async () => {
  const { marketCatalog, getMarket } = await import("../stockroom/markets");
  assert.throws(() => getMarket("arbitrary-market"), /Unknown/);
  for (const m of marketCatalog) {
    const selected = createClient(
      creditIdl,
      oracleIdl,
      { connection: new Connection("https://api.devnet.solana.com") },
      {
        admin,
        collateralMint: new PublicKey(m.collateralMint),
        debtMint: new PublicKey(m.debtMint),
        oracleAccount: new PublicKey(m.oracleAccount),
      },
    );
    await verifySponsor({
      wallet: owner.toBase58(),
      marketId: m.id,
      kind: "faucet",
      transaction: encoded(await pack(selected, m)),
    });
    const tx = new Transaction({
      feePayer: owner,
      recentBlockhash: blockhash,
    }).add(
      compute(),
      await selected.publish(BigInt(m.demoPrice) * 1000000n),
      await selected.depositCollateral(owner, 800000000n),
      await selected.borrow(owner, 500000000n),
    );
    await verifySponsor({
      wallet: owner.toBase58(),
      marketId: m.id,
      kind: "open",
      transaction: encoded(tx),
    });
    const wrongMarket = marketCatalog.find((x) => x.id !== m.id)!;
    await assert.rejects(
      verifySponsor({
        wallet: owner.toBase58(),
        marketId: wrongMarket.id,
        kind: "open",
        transaction: encoded(tx),
      }),
      /fixed demo price/,
    );
    tx.instructions[2] = await c.depositCollateral(owner, 800000000n);
    await assert.rejects(
      verifySponsor({
        wallet: owner.toBase58(),
        marketId: m.id,
        kind: "open",
        transaction: encoded(tx),
      }),
      /Unexpected instruction/,
    );
  }
});
