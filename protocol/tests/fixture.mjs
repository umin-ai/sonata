// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { getTransactionDecoder } from "@solana/kit";
import {
  Keypair,
  Transaction,
  SystemProgram,
  Connection,
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
  createInitializePermanentDelegateInstruction,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
import {
  createClient,
  CREDIT_ID,
  ORACLE_ID,
  positionAddress,
} from "../sdk/client.mjs";
export const CASH = 1_000_000n;
export const STOCK = 100_000_000n;
export async function fixture({
  freezeAuthority = false,
  permanentDelegate = false,
  skipInitialize = false,
} = {}) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(
    CREDIT_ID.toBase58(),
    "target/deploy/stockroom_credit.so",
  );
  svm.addProgramFromFile(ORACLE_ID.toBase58(), "target/deploy/demo_oracle.so");
  const clock = svm.getClock();
  clock.unixTimestamp = 1_800_000_000n;
  svm.setClock(clock);
  const keys = Object.fromEntries(
    [
      "admin",
      "lender",
      "borrower",
      "liquidator",
      "attacker",
      "stockMint",
      "cashMint",
      "oracleAccount",
    ].map((name) => [name, Keypair.generate()]),
  );
  for (const name of ["admin", "lender", "borrower", "liquidator", "attacker"])
    svm.airdrop(keys[name].publicKey.toBase58(), 20_000_000_000n);
  const provider = new anchor.AnchorProvider(
    new Connection("http://127.0.0.1:8899"),
    new anchor.Wallet(keys.admin),
    {},
  );
  const client = createClient(
    JSON.parse(readFileSync("target/idl/stockroom_credit.json")),
    JSON.parse(readFileSync("target/idl/demo_oracle.json")),
    provider,
    {
      admin: keys.admin.publicKey,
      collateralMint: keys.stockMint.publicKey,
      debtMint: keys.cashMint.publicKey,
      oracleAccount: keys.oracleAccount.publicKey,
    },
  );
  const receipts = [];
  async function send(instructions, signers = [keys.admin], expectError) {
    svm.expireBlockhash();
    const ixs = (
      await Promise.all(
        Array.isArray(instructions) ? instructions : [instructions],
      )
    ).flat();
    const tx = new Transaction({
      feePayer: signers[0].publicKey,
      recentBlockhash: svm.latestBlockhash(),
    }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ...ixs,
    );
    tx.sign(...signers);
    const result = svm.sendTransaction(
      getTransactionDecoder().decode(tx.serialize()),
    );
    const failed = result instanceof FailedTransactionMetadata;
    const meta = failed ? result.meta() : result;
    if (expectError) {
      assert.equal(failed, true, "Expected transaction failure");
      assert.match(meta.logs().join("\n"), expectError);
    } else if (failed)
      throw new Error(`${result.err()}\n${meta.logs().join("\n")}`);
    receipts.push({
      success: !failed,
      computeUnits: Number(meta.computeUnitsConsumed()),
      logs: meta.logs(),
    });
    return result;
  }
  const mintSpace = getMintLen([
    ExtensionType.ScaledUiAmountConfig,
    ...(permanentDelegate ? [ExtensionType.PermanentDelegate] : []),
  ]);
  const createMintAccount = (key, space, programId) =>
    SystemProgram.createAccount({
      fromPubkey: keys.admin.publicKey,
      newAccountPubkey: key.publicKey,
      space,
      lamports: Number(svm.minimumBalanceForRentExemption(BigInt(space))),
      programId,
    });
  await send(
    [
      createMintAccount(keys.cashMint, MINT_SIZE, TOKEN_PROGRAM_ID),
      createInitializeMint2Instruction(
        keys.cashMint.publicKey,
        6,
        keys.admin.publicKey,
        null,
        TOKEN_PROGRAM_ID,
      ),
    ],
    [keys.admin, keys.cashMint],
  );
  await send(
    [
      createMintAccount(keys.stockMint, mintSpace, TOKEN_2022_PROGRAM_ID),
      createInitializeScaledUiAmountConfigInstruction(
        keys.stockMint.publicKey,
        keys.admin.publicKey,
        1,
        TOKEN_2022_PROGRAM_ID,
      ),
      ...(permanentDelegate
        ? [
            createInitializePermanentDelegateInstruction(
              keys.stockMint.publicKey,
              keys.admin.publicKey,
              TOKEN_2022_PROGRAM_ID,
            ),
          ]
        : []),
      createInitializeMint2Instruction(
        keys.stockMint.publicKey,
        8,
        keys.admin.publicKey,
        freezeAuthority ? keys.admin.publicKey : null,
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [keys.admin, keys.stockMint],
  );
  for (const name of ["lender", "borrower", "liquidator", "attacker"]) {
    const owner = keys[name].publicKey;
    await send([
      createAssociatedTokenAccountIdempotentInstruction(
        keys.admin.publicKey,
        client.cash(owner).userCash,
        owner,
        keys.cashMint.publicKey,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        keys.admin.publicKey,
        client.collateral(owner).userStock,
        owner,
        keys.stockMint.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ),
      createMintToCheckedInstruction(
        keys.cashMint.publicKey,
        client.cash(owner).userCash,
        keys.admin.publicKey,
        (name === "borrower" ? 50n : 10_000n) * CASH,
        6,
      ),
      createMintToCheckedInstruction(
        keys.stockMint.publicKey,
        client.collateral(owner).userStock,
        keys.admin.publicKey,
        20n * STOCK,
        8,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ]);
  }
  await send(client.initializeOracle(), [keys.admin, keys.oracleAccount]);
  if (!skipInitialize) {
    await send(client.initializeMarket());
    for (const name of ["lender", "borrower", "liquidator", "attacker"])
      await send(client.initializePosition(keys[name].publicKey), [keys[name]]);
  }
  const read = (type, pubkey) =>
    client.credit.coder.accounts.decode(
      type,
      Buffer.from(svm.getAccount(pubkey.toBase58()).data),
    );
  const tokenBalance = (pubkey) =>
    Buffer.from(svm.getAccount(pubkey.toBase58()).data).readBigUInt64LE(64);
  const market = () => read("market", client.market);
  const position = (who = keys.borrower) =>
    read("position", positionAddress(client.market, who.publicKey));
  const snapshot = () =>
    [
      client.market,
      client.cashVault,
      client.collateralVault,
      ...["lender", "borrower", "liquidator", "attacker"].flatMap((name) => [
        positionAddress(client.market, keys[name].publicKey),
        client.cash(keys[name].publicKey).userCash,
        client.collateral(keys[name].publicKey).userStock,
      ]),
    ].map((key) =>
      Buffer.from(svm.getAccount(key.toBase58()).data).toString("hex"),
    );
  const advance = (seconds) => {
    const c = svm.getClock();
    c.unixTimestamp += BigInt(seconds);
    svm.setClock(c);
  };
  async function openLoan(amount = 500n * CASH) {
    await send(client.supply(keys.lender.publicKey, 5_000n * CASH), [
      keys.lender,
    ]);
    await send(client.depositCollateral(keys.borrower.publicKey, 10n * STOCK), [
      keys.borrower,
    ]);
    await send(client.borrow(keys.borrower.publicKey, amount), [keys.borrower]);
  }
  return {
    svm,
    keys,
    client,
    send,
    market,
    position,
    tokenBalance,
    snapshot,
    advance,
    openLoan,
    receipts,
  };
}
