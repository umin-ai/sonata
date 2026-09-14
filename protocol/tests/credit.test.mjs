// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTransferCheckedInstruction,
  createUpdateMultiplierDataInstruction,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { fixture, CASH, STOCK } from "./fixture.mjs";
import { bn, U128_MAX, positionAddress } from "../sdk/client.mjs";
const n = (value) => BigInt(value.toString());
async function mustRollback(f, instruction, signers, error) {
  const before = f.snapshot();
  await f.send(instruction, signers, error);
  assert.deepEqual(
    f.snapshot(),
    before,
    "Failed transaction must roll back token and protocol state",
  );
}

test("lender → collateral → loan → accrued repayment → collateral release → lender redemption", async () => {
  const f = await fixture();
  const { client: c, keys: k } = f;
  await f.openLoan();
  assert.equal(
    f.tokenBalance(c.cash(k.borrower.publicKey).userCash),
    550n * CASH,
  );
  assert.equal(f.position().collateral.toString(), String(10n * STOCK));
  assert.equal(f.tokenBalance(c.collateralVault), 10n * STOCK);
  f.advance(30 * 86400);
  await f.send(c.publish(200n * CASH));
  await f.send(c.repay(k.borrower.publicKey, U128_MAX, 510n * CASH), [
    k.borrower,
  ]);
  const earned = n(f.market().cash) - 5_000n * CASH;
  assert(
    earned > 2n * CASH && earned < 3n * CASH,
    "Accrued 30-day interest should reach lenders",
  );
  assert.equal(n(f.market().debtShares), 0n);
  assert.equal(n(f.market().debtAssets), 0n);
  await f.send(c.withdrawCollateral(k.borrower.publicKey, 10n * STOCK), [
    k.borrower,
  ]);
  assert.equal(
    f.tokenBalance(c.collateral(k.borrower.publicKey).userStock),
    20n * STOCK,
  );
  await f.send(c.redeem(k.lender.publicKey, U128_MAX, 5_000n * CASH), [
    k.lender,
  ]);
  assert(f.tokenBalance(c.cash(k.lender.publicKey).userCash) > 10_000n * CASH);
  assert(
    f.tokenBalance(c.cashVault) <= 1n,
    "At most one quote atom of virtual-share dust",
  );
});

test("opening LTV and cash availability reject unsafe actions atomically", async () => {
  const f = await fixture();
  const { client: c, keys: k } = f;
  await f.openLoan();
  await mustRollback(
    f,
    c.borrow(k.borrower.publicKey, 501n * CASH),
    [k.borrower],
    /Unhealthy/,
  );
  await mustRollback(
    f,
    c.borrow(k.borrower.publicKey, 5_000n * CASH),
    [k.borrower],
    /InsufficientLiquidity/,
  );
  await mustRollback(
    f,
    c.withdrawCollateral(k.borrower.publicKey, 6n * STOCK),
    [k.borrower],
    /Unhealthy/,
  );
  await mustRollback(
    f,
    c.redeem(k.lender.publicKey),
    [k.lender],
    /InsufficientLiquidity/,
  );
  await mustRollback(
    f,
    c.liquidate(k.liquidator.publicKey, k.borrower.publicKey, STOCK),
    [k.liquidator],
    /HealthyPosition/,
  );
});

test("position owner, vault, mint and oracle bindings reject substitution", async () => {
  const f = await fixture();
  const { client: c, keys: k } = f;
  await f.openLoan();
  const forged = c.credit.methods
    .repay(U128_MAX, bn(1000n * CASH))
    .accountsStrict({
      ...c.cash(k.attacker.publicKey),
      position: positionAddress(c.market, k.borrower.publicKey),
    })
    .instruction();
  await mustRollback(
    f,
    forged,
    [k.attacker],
    /ConstraintHasOne|ConstraintSeeds/,
  );
  const badVault = c.credit.methods
    .supply(bn(CASH), bn(1))
    .accountsStrict({
      ...c.cash(k.lender.publicKey),
      cashVault: c.cash(k.attacker.publicKey).userCash,
    })
    .instruction();
  await mustRollback(
    f,
    badVault,
    [k.lender],
    /ConstraintAddress|ConstraintTokenOwner/,
  );
  const badMint = c.credit.methods
    .supply(bn(CASH), bn(1))
    .accountsStrict({
      ...c.cash(k.lender.publicKey),
      debtMint: k.stockMint.publicKey,
    })
    .instruction();
  await mustRollback(
    f,
    badMint,
    [k.lender],
    /AccountOwnedByWrongProgram|ConstraintAddress/,
  );
  const badOracle = c.credit.methods
    .borrow(bn(CASH), U128_MAX)
    .accountsStrict({
      cash: c.cash(k.borrower.publicKey),
      oracle: k.stockMint.publicKey,
    })
    .instruction();
  await mustRollback(
    f,
    badOracle,
    [k.borrower],
    /AccountOwnedByWrongProgram|ConstraintAddress/,
  );
  const falsePublisher = c.oracle.methods
    .publish(bn(CASH), bn(0), true)
    .accountsStrict({
      authority: k.attacker.publicKey,
      price: k.oracleAccount.publicKey,
    })
    .instruction();
  await f.send(falsePublisher, [k.attacker], /ConstraintHasOne/);
  const unsigned = await c.borrow(k.borrower.publicKey, CASH);
  unsigned.keys.find((key) =>
    key.pubkey.equals(k.borrower.publicKey),
  ).isSigner = false;
  await mustRollback(f, unsigned, [k.attacker], /AccountNotSigner/);
});

test("stale, uncertain and closed-market prices stop new risk; repayment and top-up remain available", async () => {
  const f = await fixture();
  const { client: c, keys: k } = f;
  await f.openLoan();
  f.advance(121);
  await mustRollback(
    f,
    c.borrow(k.borrower.publicKey, CASH),
    [k.borrower],
    /StalePrice/,
  );
  await mustRollback(
    f,
    c.withdrawCollateral(k.borrower.publicKey, STOCK),
    [k.borrower],
    /StalePrice/,
  );
  await mustRollback(
    f,
    c.liquidate(k.liquidator.publicKey, k.borrower.publicKey, STOCK),
    [k.liquidator],
    /StalePrice/,
  );
  await f.send(c.depositCollateral(k.borrower.publicKey, STOCK), [k.borrower]);
  await f.send(
    c.repay(k.borrower.publicKey, n(f.position().debtShares) / 2n, 260n * CASH),
    [k.borrower],
  );
  await f.send(c.publish(200n * CASH, 3n * CASH));
  await mustRollback(
    f,
    c.borrow(k.borrower.publicKey, CASH),
    [k.borrower],
    /UncertainPrice/,
  );
  await f.send(c.publish(200n * CASH, 0n, false));
  await mustRollback(
    f,
    c.borrow(k.borrower.publicKey, CASH),
    [k.borrower],
    /MarketClosed/,
  );
  await f.send(c.repay(k.borrower.publicKey), [k.borrower]);
  f.advance(1000);
  await f.send(c.withdrawCollateral(k.borrower.publicKey, 11n * STOCK), [
    k.borrower,
  ]);
});

test("pause authority is constrained; a pause cannot block repayment or debt-free collateral release", async () => {
  const f = await fixture();
  const { client: c, keys: k } = f;
  await f.openLoan();
  await f.send(
    c.credit.methods
      .setPaused(true)
      .accountsStrict({ admin: k.attacker.publicKey, market: c.market })
      .instruction(),
    [k.attacker],
    /ConstraintHasOne/,
  );
  await f.send(c.pause(true));
  await mustRollback(
    f,
    c.borrow(k.borrower.publicKey, CASH),
    [k.borrower],
    /Paused/,
  );
  await f.send(c.repay(k.borrower.publicKey), [k.borrower]);
  await f.send(c.withdrawCollateral(k.borrower.publicKey, 10n * STOCK), [
    k.borrower,
  ]);
});

test("slippage bounds and insufficient token funds roll back accounting", async () => {
  const f = await fixture();
  const { client: c, keys: k } = f;
  await f.openLoan();
  await mustRollback(
    f,
    c.supply(k.lender.publicKey, CASH, U128_MAX),
    [k.lender],
    /Slippage/,
  );
  await mustRollback(
    f,
    c.borrow(k.borrower.publicKey, CASH, 1n),
    [k.borrower],
    /Slippage/,
  );
  await mustRollback(
    f,
    c.repay(k.borrower.publicKey, U128_MAX, CASH),
    [k.borrower],
    /Slippage/,
  );
  await mustRollback(
    f,
    c.supply(k.lender.publicKey, 10_000n * CASH),
    [k.lender],
    /insufficient funds/i,
  );
  await mustRollback(
    f,
    c.depositCollateral(k.borrower.publicKey, 100n * STOCK),
    [k.borrower],
    /insufficient funds/i,
  );
});

test("partial liquidation transfers paid collateral with the bounded bonus", async () => {
  const f = await fixture();
  const { client: c, keys: k } = f;
  await f.openLoan(900n * CASH);
  await f.send(c.publish(100n * CASH));
  await mustRollback(
    f,
    c.liquidate(k.liquidator.publicKey, k.borrower.publicKey, STOCK, CASH),
    [k.liquidator],
    /Slippage/,
  );
  const cashBefore = f.tokenBalance(c.cash(k.liquidator.publicKey).userCash);
  await f.send(
    c.liquidate(
      k.liquidator.publicKey,
      k.borrower.publicKey,
      4n * STOCK,
      400n * CASH,
    ),
    [k.liquidator],
  );
  const paid =
    cashBefore - f.tokenBalance(c.cash(k.liquidator.publicKey).userCash);
  assert.equal(paid, 380_952_381n);
  assert.equal(
    f.tokenBalance(c.collateral(k.liquidator.publicKey).userStock),
    24n * STOCK,
  );
  assert.equal(n(f.position().collateral), 6n * STOCK);
  assert.equal(n(f.market().cash) + n(f.market().debtAssets), 5_000n * CASH);
});

test("exhausted collateral writes residual bad debt down against lender NAV", async () => {
  const f = await fixture();
  const { client: c, keys: k } = f;
  await f.openLoan(900n * CASH);
  await f.send(c.publish(50n * CASH, 0n, false));
  await f.send(
    c.liquidate(
      k.liquidator.publicKey,
      k.borrower.publicKey,
      10n * STOCK,
      500n * CASH,
    ),
    [k.liquidator],
  );
  assert.equal(n(f.position().collateral), 0n);
  assert.equal(n(f.position().debtShares), 0n);
  assert.equal(n(f.market().debtAssets), 0n);
  assert.equal(n(f.market().debtShares), 0n);
  assert(
    n(f.market().cash) < 4_600n * CASH && n(f.market().cash) > 4_500n * CASH,
  );
  await f.send(c.redeem(k.lender.publicKey), [k.lender]);
  assert(
    f.tokenBalance(c.cash(k.lender.publicKey).userCash) < 10_000n * CASH,
    "Lender, not a fictitious insurance balance, absorbs loss",
  );
});

test("raw-unit valuation is unaffected by a Scaled UI Amount display change", async () => {
  const f = await fixture();
  const { client: c, keys: k } = f;
  await f.openLoan();
  await f.send(
    createUpdateMultiplierDataInstruction(
      k.stockMint.publicKey,
      k.admin.publicKey,
      2,
      0n,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  assert.equal(n(f.position().collateral), 10n * STOCK);
  await mustRollback(
    f,
    c.borrow(k.borrower.publicKey, 501n * CASH),
    [k.borrower],
    /Unhealthy/,
  );
  await f.send(c.borrow(k.borrower.publicKey, 500n * CASH), [k.borrower]);
});

test("unsolicited vault donations cannot inflate accounted NAV or dilute depositors", async () => {
  const f = await fixture();
  const { client: c, keys: k } = f;
  await f.send(c.supply(k.attacker.publicKey, 1n), [k.attacker]);
  await f.send(
    createTransferCheckedInstruction(
      c.cash(k.attacker.publicKey).userCash,
      k.cashMint.publicKey,
      c.cashVault,
      k.attacker.publicKey,
      1000n * CASH,
      6,
    ),
    [k.attacker],
  );
  assert.equal(n(f.market().cash), 1n);
  await f.send(c.supply(k.lender.publicKey, 100n * CASH), [k.lender]);
  await f.send(c.redeem(k.attacker.publicKey), [k.attacker]);
  assert.equal(
    f.tokenBalance(c.cash(k.attacker.publicKey).userCash),
    9_000n * CASH,
  );
  await f.send(c.redeem(k.lender.publicKey), [k.lender]);
  assert.equal(
    f.tokenBalance(c.cash(k.lender.publicKey).userCash),
    10_000n * CASH,
  );
});

test("freeze authority and permanent delegate collateral mints are refused", async () => {
  for (const options of [
    { freezeAuthority: true },
    { permanentDelegate: true },
  ]) {
    const f = await fixture({ ...options, skipInitialize: true });
    await f.send(
      f.client.initializeMarket(),
      [f.keys.admin],
      /UnsupportedMint/,
    );
    assert.equal(f.svm.getAccount(f.client.market.toBase58()).exists, false);
  }
});

test("multiple debt holders and partial repayments close without phantom debt", async () => {
  const f = await fixture();
  const { client: c, keys: k } = f;
  await f.openLoan(333n * CASH);
  await f.send(c.depositCollateral(k.attacker.publicKey, 5n * STOCK), [
    k.attacker,
  ]);
  await f.send(c.borrow(k.attacker.publicKey, 217n * CASH), [k.attacker]);
  f.advance(86400);
  await f.send(c.publish(200n * CASH));
  await f.send(c.repay(k.borrower.publicKey, n(f.position().debtShares) / 3n), [
    k.borrower,
  ]);
  await f.send(c.repay(k.attacker.publicKey), [k.attacker]);
  await f.send(c.repay(k.borrower.publicKey), [k.borrower]);
  assert.equal(n(f.market().debtAssets), 0n);
  assert.equal(n(f.market().debtShares), 0n);
  assert.equal(n(f.position(k.attacker).debtShares), 0n);
  assert.equal(n(f.position().debtShares), 0n);
  assert.equal(n(f.market().cash), f.tokenBalance(c.cashVault));
});
