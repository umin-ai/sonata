// SPDX-License-Identifier: GPL-3.0-or-later
import anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
export const { BN } = anchor;
export const U128_MAX = new BN("340282366920938463463374607431768211455");
export const U64_MAX = new BN("18446744073709551615");
export const bn = (value) => new BN(String(value));
export const CREDIT_ID = new PublicKey(
  "4sS8MrfTUjavLyMs5GtircsjMab5vfVZdLE7YPcZo9BH",
);
export const ORACLE_ID = new PublicKey(
  "E45Bq8CUh12Fncuyd5GMHKgkmjpVp8n2C7521ExryDwg",
);
export const TREASURY_ID = new PublicKey(
  "GPANv5zMEmvkVKQxJgLds2B4bEbnub6HhS2WQq71fjNj",
);
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export function marketAddresses(admin, collateralMint, debtMint) {
  const [market] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      admin.toBuffer(),
      collateralMint.toBuffer(),
      debtMint.toBuffer(),
    ],
    CREDIT_ID,
  );
  return {
    market,
    cashVault: PublicKey.findProgramAddressSync(
      [Buffer.from("cash"), market.toBuffer()],
      CREDIT_ID,
    )[0],
    collateralVault: PublicKey.findProgramAddressSync(
      [Buffer.from("collateral"), market.toBuffer()],
      CREDIT_ID,
    )[0],
  };
}
export function positionAddress(market, owner) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), owner.toBuffer()],
    CREDIT_ID,
  )[0];
}
export function createClient(creditIdl, oracleIdl, provider, config) {
  const credit = new anchor.Program(creditIdl, provider);
  const oracle = new anchor.Program(oracleIdl, provider);
  if (
    !credit.programId.equals(CREDIT_ID) ||
    !oracle.programId.equals(ORACLE_ID)
  )
    throw new Error("IDL program address mismatch");
  const { admin, collateralMint, debtMint, oracleAccount } = config;
  const addresses = marketAddresses(admin, collateralMint, debtMint);
  const { market } = addresses;
  const cash = (owner) => ({
    owner,
    market,
    position: positionAddress(market, owner),
    debtMint,
    cashVault: addresses.cashVault,
    userCash: getAssociatedTokenAddressSync(debtMint, owner),
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  const collateral = (owner) => ({
    owner,
    market,
    position: positionAddress(market, owner),
    collateralMint,
    collateralVault: addresses.collateralVault,
    userStock: getAssociatedTokenAddressSync(
      collateralMint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
    ),
    collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
  });
  return {
    credit,
    oracle,
    ...addresses,
    cash,
    collateral,
    initializeMarket: (terms = {}) =>
      credit.methods
        .initializeMarket(
          terms.aprBps ?? 500,
          terms.openingLtvBps ?? 5000,
          terms.liquidationLtvBps ?? 6500,
          terms.bonusBps ?? 500,
          terms.maxPriceAge ?? 120,
        )
        .accountsStrict({
          admin,
          collateralMint,
          debtMint,
          ...addresses,
          oracle: oracleAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    initializePosition: (owner) =>
      credit.methods
        .initializePosition()
        .accountsStrict({
          owner,
          payer: owner,
          market,
          position: positionAddress(market, owner),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    supply: (owner, assets, minShares = 1n) =>
      credit.methods
        .supply(bn(assets), bn(minShares))
        .accountsStrict(cash(owner))
        .instruction(),
    redeem: (owner, shares = U128_MAX, minAssets = 1n) =>
      credit.methods
        .redeem(bn(shares), bn(minAssets))
        .accountsStrict(cash(owner))
        .instruction(),
    depositCollateral: (owner, amount) =>
      credit.methods
        .depositCollateral(bn(amount))
        .accountsStrict(collateral(owner))
        .instruction(),
    borrow: (owner, amount, maxShares = U128_MAX) =>
      credit.methods
        .borrow(bn(amount), bn(maxShares))
        .accountsStrict({ cash: cash(owner), oracle: oracleAccount })
        .instruction(),
    repay: (owner, shares = U128_MAX, maxAssets = U64_MAX) =>
      credit.methods
        .repay(bn(shares), bn(maxAssets))
        .accountsStrict(cash(owner))
        .instruction(),
    withdrawCollateral: (owner, amount) =>
      credit.methods
        .withdrawCollateral(bn(amount))
        .accountsStrict({
          collateral: collateral(owner),
          oracle: oracleAccount,
        })
        .instruction(),
    liquidate: (liquidator, borrower, seized, maxRepay = U64_MAX) =>
      credit.methods
        .liquidate(bn(seized), bn(maxRepay))
        .accountsStrict({
          liquidator,
          market,
          position: positionAddress(market, borrower),
          oracle: oracleAccount,
          debtMint,
          collateralMint,
          ...addresses,
          liquidatorCash: cash(liquidator).userCash,
          liquidatorStock: collateral(liquidator).userStock,
          tokenProgram: TOKEN_PROGRAM_ID,
          collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .instruction(),
    initializeOracle: (price = 200_000_000n) =>
      oracle.methods
        .initialize(collateralMint, debtMint, bn(price))
        .accountsStrict({
          authority: admin,
          price: oracleAccount,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    publish: (price, confidence = 0n, trading = true) =>
      oracle.methods
        .publish(bn(price), bn(confidence), trading)
        .accountsStrict({ authority: admin, price: oracleAccount })
        .instruction(),
    pause: (paused) =>
      credit.methods
        .setPaused(paused)
        .accountsStrict({ admin, market })
        .instruction(),
  };
}
