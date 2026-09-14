// SPDX-License-Identifier: GPL-3.0-or-later
import "./polyfills.mjs";
import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  SystemProgram,
  ComputeBudgetProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
  getScaledUiAmountConfig,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
} from "@solana/spl-token";
import { z } from "zod";
import {
  createClient,
  DEVNET_GENESIS,
  CREDIT_ID,
  ORACLE_ID,
  positionAddress,
  U128_MAX,
} from "./client.mjs";
import creditIdl from "./idl/stockroom_credit.json";
import oracleIdl from "./idl/demo_oracle.json";
import legacy from "./deployment.json";
import { getMarket, marketCatalog } from "./markets";
import {
  atoms,
  accruedDebt,
  assetsForShares,
  sharesForAssets,
  display,
} from "./math";

// Fixed network. No request or environment value can redirect signed transactions.
const connection = new Connection("https://api.devnet.solana.com", {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});

let checkedNetworkAt = 0;
async function devnet() {
  if (Date.now() - checkedNetworkAt > 60000) {
    if ((await connection.getGenesisHash()) !== DEVNET_GENESIS)
      throw Error("Solana Devnet verification failed.");
    checkedNetworkAt = Date.now();
  }
  return connection;
}
export function clientForMarket(marketId = "legacy") {
  const config = getMarket(marketId);
  const provider = { connection };
  return createClient(creditIdl, oracleIdl, provider, {
    admin: new PublicKey(config.admin),
    collateralMint: new PublicKey(config.collateralMint),
    debtMint: new PublicKey(config.debtMint),
    oracleAccount: new PublicKey(config.oracleAccount),
  });
}
export function ownerKey(address: string) {
  const owner = new PublicKey(address);
  if (
    !PublicKey.isOnCurve(owner.toBytes()) ||
    owner.toBase58() === legacy.admin
  )
    throw Error("Connect a user wallet on Devnet.");
  return owner;
}
const big = (n: { toString(): string }) => BigInt(n.toString());
async function read(address: string | undefined, marketId: string) {
  const config = getMarket(marketId);
  await devnet();
  const c = clientForMarket(marketId),
    owner = address ? ownerKey(address) : null;
  const keys = [
    c.market,
    new PublicKey(config.oracleAccount),
    SYSVAR_CLOCK_PUBKEY,
  ];
  if (owner)
    keys.push(
      positionAddress(c.market, owner),
      c.cash(owner).userCash,
      c.collateral(owner).userStock,
      owner,
    );
  const mintIndex = keys.length;
  keys.push(new PublicKey(config.collateralMint));
  const { context, value } = await connection.getMultipleAccountsInfoAndContext(
    keys,
    "confirmed",
  );
  if (!value[0]?.owner.equals(CREDIT_ID) || !value[1]?.owner.equals(ORACLE_ID))
    throw Error("Demo market accounts failed verification.");
  const m = c.credit.coder.accounts.decode("market", value[0].data);
  const o = c.oracle.coder.accounts.decode("demoPrice", value[1].data);
  if (
    !m.admin.equals(new PublicKey(config.admin)) ||
    m.collateralMint.toBase58() !== config.collateralMint ||
    m.debtMint.toBase58() !== config.debtMint ||
    m.oracle.toBase58() !== config.oracleAccount ||
    m.cashVault.toBase58() !== config.cashVault ||
    m.collateralVault.toBase58() !== config.collateralVault
  )
    throw Error("Demo market configuration changed.");
  if (
    m.aprBps !== 500 ||
    m.openingLtvBps !== 5000 ||
    m.liquidationLtvBps !== 6500 ||
    big(o.price) !== BigInt(config.demoPrice) * 1000000n ||
    !o.authority.equals(new PublicKey(config.admin))
  )
    throw Error("Demo terms changed. Refresh integration before continuing.");
  const mint = unpackMint(
    new PublicKey(config.collateralMint),
    value[mintIndex],
    TOKEN_2022_PROGRAM_ID,
  );
  const scaled = getScaledUiAmountConfig(mint);
  if (
    mint.decimals !== 8 ||
    !scaled ||
    scaled.multiplier !== 1 ||
    scaled.newMultiplier !== 1 ||
    mint.freezeAuthority !== null
  )
    throw Error("Mock token configuration changed. Transactions are disabled.");
  if (!value[2] || value[2].data.length !== 40)
    throw Error("Network clock unavailable.");
  const now = value[2].data.readBigInt64LE(32);
  const debt = accruedDebt(
    big(m.debtAssets),
    BigInt(m.aprBps),
    now - big(m.lastAccrual),
    big(m.interestRemainder),
  );
  let p = null;
  if (owner && value[3]) {
    if (!value[3].owner.equals(CREDIT_ID))
      throw Error("Invalid position owner.");
    p = c.credit.coder.accounts.decode("position", value[3].data);
    if (!p.owner.equals(owner!) || !p.market.equals(c.market))
      throw Error("Invalid user position.");
  }
  function token(index: number, mint: string, program: PublicKey) {
    const a = value[index];
    if (!a) return 0n;
    if (
      !a.owner.equals(program) ||
      a.data.length < 165 ||
      new PublicKey(a.data.subarray(0, 32)).toBase58() !== mint ||
      !new PublicKey(a.data.subarray(32, 64)).equals(owner!) ||
      a.data[108] !== 1
    )
      throw Error("Demo token account failed verification.");
    return a.data.readBigUInt64LE(64);
  }
  return {
    c,
    owner,
    m,
    o,
    p,
    now,
    debt,
    slot: context.slot,
    cash: big(m.cash),
    supplyShares: big(m.supplyShares),
    debtShares: big(m.debtShares),
    walletCash: owner ? token(4, config.debtMint, TOKEN_PROGRAM_ID) : 0n,
    walletStock: owner
      ? token(5, config.collateralMint, TOKEN_2022_PROGRAM_ID)
      : 0n,
    sol: owner ? (value[6]?.lamports ?? 0) / 1e9 : 0,
  };
}
export async function demoSnapshot(address?: string, marketId = "legacy") {
  const config = getMarket(marketId);
  const s = await read(address, marketId),
    userDebt = s.p
      ? assetsForShares(big(s.p.debtShares), s.debt, s.debtShares, true)
      : 0n;
  const collateral = s.p ? big(s.p.collateral) : 0n;
  return {
    network: "solana:devnet",
    slot: s.slot,
    fetchedAt: new Date().toISOString(),
    market: config.market,
    creditProgram: config.creditProgram,
    oracleProgram: config.oracleProgram,
    collateralMint: config.collateralMint,
    debtMint: config.debtMint,
    liquidity: display(s.cash, 6),
    totalBorrowed: display(s.debt, 6),
    apr: 0.05,
    openingLtv: 0.5,
    liquidationLtv: 0.65,
    price: config.demoPrice,
    paused: s.m.paused,
    oraclePublishedAt: Number(s.o.publishedAt) * 1000,
    oracleAge: Number(s.now - big(s.o.publishedAt)),
    wallet: address
      ? {
          address,
          sol: s.sol,
          cash: display(s.walletCash, 6),
          stock: display(s.walletStock, 8),
        }
      : null,
    position: {
      exists: !!s.p,
      address: address
        ? positionAddress(s.c.market, s.owner!).toBase58()
        : null,
      collateral: display(collateral, 8),
      debt: display(userDebt, 6),
      supplied: display(
        s.p
          ? assetsForShares(
              big(s.p.supplyShares),
              s.cash + s.debt,
              s.supplyShares,
            )
          : 0n,
        6,
      ),
      borrowCapacity: Math.max(
        0,
        display(collateral, 8) * config.demoPrice * 0.5 - display(userDebt, 6),
      ),
      hasSupply: !!s.p && big(s.p.supplyShares) > 0n,
      hasDebt: !!s.p && big(s.p.debtShares) > 0n,
    },
  };
}
export const DemoAction = z
  .object({
    wallet: z.string().min(32).max(44),
    marketId: z.string().max(20),
    kind: z.enum([
      "faucet",
      "open",
      "deposit",
      "borrow",
      "repay",
      "withdraw",
      "supply",
      "redeem",
    ]),
    amount: z.string().max(30).default("0"),
    collateral: z.string().max(30).default("0"),
  })
  .strict();
export type DemoActionInput = z.infer<typeof DemoAction>;
export async function prepareDemo(input: DemoActionInput) {
  const config = getMarket(input.marketId);
  const s = await read(input.wallet, input.marketId),
    { c, owner, m, p } = s,
    authority = { publicKey: new PublicKey(config.admin) },
    kind = input.kind;
  if (!owner) throw Error("Connect a wallet first.");
  const ixs = [],
    limits: Record<string, string | number> = {};
  if (kind === "faucet") {
    if (p)
      throw Error(
        "This wallet already claimed this market’s starter assets. Use the balances in your wallet.",
      );
    if (
      (await connection.getBalance(authority.publicKey, "confirmed")) < 25000000
    )
      throw Error(
        "The test faucet budget is low. Existing positions can still be repaid.",
      );
    ixs.push(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: owner,
        lamports: 5000000,
      }),
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey,
        c.cash(owner).userCash,
        owner,
        new PublicKey(config.debtMint),
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey,
        c.collateral(owner).userStock,
        owner,
        new PublicKey(config.collateralMint),
        TOKEN_2022_PROGRAM_ID,
      ),
      createMintToCheckedInstruction(
        new PublicKey(config.debtMint),
        c.cash(owner).userCash,
        authority.publicKey,
        1000000000n,
        6,
      ),
      createMintToCheckedInstruction(
        new PublicKey(config.collateralMint),
        c.collateral(owner).userStock,
        authority.publicKey,
        2500000000n,
        8,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
      await c.initializePosition(owner),
    );
    Object.assign(limits, { stock: 25, cash: 1000, testSolGrant: 0.005 });
  } else {
    if (!p) throw Error("Get demo assets to initialize your position first.");
    if (s.sol < 0.00001)
      throw Error("Your wallet needs Devnet SOL for network fees.");
    if (m.paused && ["open", "borrow", "deposit", "supply"].includes(kind))
      throw Error("New lending activity is paused.");
    if (["open", "borrow", "withdraw"].includes(kind))
      ixs.push(await c.publish(BigInt(config.demoPrice) * 1000000n));
    const userDebt = assetsForShares(
      big(p.debtShares),
      s.debt,
      s.debtShares,
      true,
    );
    if (kind === "open" || kind === "deposit") {
      const amount = atoms(input.collateral, 8, 25n);
      if (amount > s.walletStock)
        throw Error("Not enough demo stocks in your wallet.");
      ixs.push(await c.depositCollateral(owner, amount));
      limits.collateral = display(amount, 8);
    }
    if (kind === "open" || kind === "borrow") {
      const amount = atoms(input.amount, 6, 2500n),
        collateral =
          big(p.collateral) +
          (kind === "open" ? atoms(input.collateral, 8, 25n) : 0n);
      if (amount > s.cash)
        throw Error("Not enough available lending liquidity.");
      if (
        userDebt + amount >
        (collateral * BigInt(config.demoPrice) * 1000000n * 5000n) /
          (100000000n * 10000n)
      )
        throw Error("This amount exceeds the 50% opening loan-to-value limit.");
      const maxShares =
        (sharesForAssets(amount, s.debt, s.debtShares, true) * 1001n) / 1000n +
        1n;
      ixs.push(await c.borrow(owner, amount, maxShares));
      limits.cash = display(amount, 6);
      limits.maxDebtShares = maxShares.toString();
    }
    if (kind === "repay") {
      if (big(p.debtShares) === 0n) throw Error("There is no loan to repay.");
      const maxAssets = userDebt + userDebt / 1000n + 10000n;
      if (maxAssets > s.walletCash)
        throw Error("Keep enough demo USD for principal and interest.");
      ixs.push(await c.repay(owner, U128_MAX, maxAssets));
      limits.estimatedCash = display(userDebt, 6);
      limits.maximumCash = display(maxAssets, 6);
    }
    if (kind === "withdraw") {
      if (big(p.debtShares) > 0n)
        throw Error("Repay the loan before releasing all collateral.");
      if (big(p.collateral) === 0n)
        throw Error("There is no collateral to release.");
      ixs.push(await c.withdrawCollateral(owner, big(p.collateral)));
      limits.collateral = display(big(p.collateral), 8);
    }
    if (kind === "supply") {
      const amount = atoms(input.amount, 6, 10000n);
      if (amount > s.walletCash)
        throw Error("Not enough demo USD in your wallet.");
      const expected = sharesForAssets(amount, s.cash + s.debt, s.supplyShares),
        minShares = (expected * 999n) / 1000n;
      ixs.push(await c.supply(owner, amount, minShares > 0n ? minShares : 1n));
      limits.cash = display(amount, 6);
      limits.minimumShares = minShares.toString();
    }
    if (kind === "redeem") {
      if (big(p.supplyShares) === 0n)
        throw Error("There is no supply balance to redeem.");
      const expected = assetsForShares(
        big(p.supplyShares),
        s.cash + s.debt,
        s.supplyShares,
      );
      if (expected > s.cash)
        throw Error(
          "Some supplied cash is on loan. Wait for liquidity before redeeming all.",
        );
      const minAssets = (expected * 999n) / 1000n;
      ixs.push(
        await c.redeem(owner, U128_MAX, minAssets > 0n ? minAssets : 1n),
      );
      limits.estimatedCash = display(expected, 6);
      limits.minimumCash = display(minAssets, 6);
    }
  }
  const block = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: kind === "faucet" ? authority.publicKey : owner,
    ...block,
  }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ...ixs);
  let serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  if (kind === "faucet" || ["open", "borrow", "withdraw"].includes(kind)) {
    const response = await fetch("/api/devnet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: input.wallet,
        marketId: input.marketId,
        kind,
        transaction: serialized.toString("base64"),
      }),
    });
    const reply = (await response.json()) as {
      transaction?: string;
      error?: string;
    };
    if (!response.ok || !reply.transaction)
      throw Error(reply.error || "Demo sponsorship unavailable.");
    const cosigned = Transaction.from(Buffer.from(reply.transaction, "base64"));
    if (!cosigned.serializeMessage().equals(tx.serializeMessage()))
      throw Error("The sponsor changed the reviewed transaction.");
    serialized = Buffer.from(reply.transaction, "base64");
  }
  const simulated = await connection.simulateTransaction(
    VersionedTransaction.deserialize(serialized),
    { sigVerify: false, commitment: "confirmed" },
  );
  if (simulated.value.err)
    throw Error(
      `The contract rejected this preview (${JSON.stringify(simulated.value.err)}). Nothing was sent.`,
    );
  const fee = await connection.getFeeForMessage(
    tx.compileMessage(),
    "confirmed",
  );
  return {
    network: "solana:devnet",
    kind,
    marketId: input.marketId,
    wallet: input.wallet,
    transaction: serialized.toString("base64"),
    lastValidBlockHeight: block.lastValidBlockHeight,
    expiresAt: Date.now() + 60000,
    limits,
    networkFee: (fee.value ?? 0) / 1e9,
    simulationSlot: simulated.context.slot,
    computeUnits: simulated.value.unitsConsumed,
  };
}
export async function submitDemo(encoded: string) {
  await devnet();
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > 1232) throw Error("Transaction is too large.");
  const tx = Transaction.from(bytes);
  if (!tx.verifySignatures()) throw Error("A required signature is missing.");
  return {
    signature: await connection.sendRawTransaction(bytes, {
      skipPreflight: false,
      maxRetries: 3,
    }),
    network: "solana:devnet",
  };
}
export async function demoReceipt(
  signature: string,
  lastValidBlockHeight?: number,
) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature))
    throw Error("Invalid receipt.");
  await devnet();
  const s = (
    await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    })
  ).value[0];
  const expired =
    !s &&
    lastValidBlockHeight !== undefined &&
    Number.isSafeInteger(lastValidBlockHeight) &&
    (await connection.getBlockHeight("confirmed")) > lastValidBlockHeight;
  return {
    signature,
    status: s?.err
      ? "failed"
      : expired
        ? "expired"
        : (s?.confirmationStatus ?? "pending"),
    error: s?.err ?? null,
    slot: s?.slot ?? null,
  };
}

export async function demoMarkets() {
  await devnet();
  const keys = marketCatalog.flatMap((c) =>
    [c.market, c.collateralMint, c.collateralVault].map(
      (k) => new PublicKey(k),
    ),
  );
  keys.push(SYSVAR_CLOCK_PUBKEY);
  const { context, value } = await connection.getMultipleAccountsInfoAndContext(
    keys,
    "confirmed",
  );
  const now = value.at(-1)!.data.readBigInt64LE(32);
  return marketCatalog.map((config, index) => {
    const [account, mint, vault] = value.slice(index * 3, index * 3 + 3);
    if (
      !account?.owner.equals(CREDIT_ID) ||
      !mint?.owner.equals(TOKEN_2022_PROGRAM_ID) ||
      !vault?.owner.equals(TOKEN_2022_PROGRAM_ID)
    )
      throw Error("Market registry verification failed.");
    const c = clientForMarket(config.id),
      m = c.credit.coder.accounts.decode("market", account.data);
    if (
      !m.collateralMint.equals(new PublicKey(config.collateralMint)) ||
      !m.collateralVault.equals(new PublicKey(config.collateralVault))
    )
      throw Error("Market collateral mismatch.");
    const debt = accruedDebt(
      big(m.debtAssets),
      BigInt(m.aprBps),
      now - big(m.lastAccrual),
      big(m.interestRemainder),
    );
    return {
      id: config.id,
      symbol: config.symbol,
      slot: context.slot,
      cash: display(big(m.cash), 6),
      borrowed: display(debt, 6),
      supplied: display(big(m.cash) + debt, 6),
      collateral: display(vault.data.readBigUInt64LE(64), 8),
      issued: display(mint.data.readBigUInt64LE(36), 8),
      utilization:
        big(m.cash) + debt > 0n ? Number(debt) / Number(big(m.cash) + debt) : 0,
      apr: m.aprBps / 10000,
      paused: m.paused,
    };
  });
}
export async function marketHistory(marketId: string, before?: string) {
  await devnet();
  return connection.getSignaturesForAddress(
    new PublicKey(getMarket(marketId).market),
    { limit: 12, ...(before ? { before } : {}) },
    "confirmed",
  );
}
export async function movementDetail(marketId: string, signature: string) {
  await devnet();
  const config = getMarket(marketId);
  const tx = await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw Error("Transaction details are not available yet. Try again.");
  if (
    !tx.transaction.message.accountKeys.some(
      (k) => k.pubkey.toBase58() === config.market,
    )
  )
    throw Error("Receipt does not belong to this market.");
  const accounts = tx.transaction.message.accountKeys;
  const before = tx.meta?.preTokenBalances ?? [],
    after = tx.meta?.postTokenBalances ?? [];
  const indexes = [
    ...new Set([...before, ...after].map((b) => b.accountIndex)),
  ];
  const movements = indexes.flatMap((i) => {
    const pre = before.find((b) => b.accountIndex === i),
      post = after.find((b) => b.accountIndex === i),
      b = post ?? pre!;
    if (![config.collateralMint, config.debtMint].includes(b.mint)) return [];
    const delta =
      BigInt(post?.uiTokenAmount.amount ?? "0") -
      BigInt(pre?.uiTokenAmount.amount ?? "0");
    if (delta === 0n) return [];
    const account = accounts[i].pubkey.toBase58();
    return [
      {
        account,
        owner: b.owner ?? "",
        location:
          account === config.cashVault
            ? "Lending vault"
            : account === config.collateralVault
              ? "Collateral vault"
              : "Wallet token account",
        symbol: b.mint === config.collateralMint ? config.symbol : "demo USD",
        amount: display(delta, b.uiTokenAmount.decimals),
      },
    ];
  });
  const actionNames = [
    "Supply",
    "Redeem",
    "Deposit collateral",
    "Borrow",
    "Repay",
    "Release collateral",
    "Liquidate",
  ];
  const events: {
    action: string;
    cash: number;
    collateral: number;
    badDebt: number;
    owner: string;
  }[] = [];
  // Track invocation depth so a foreign program cannot spoof Stockroom events.
  const stack: string[] = [];
  for (const log of tx.meta?.logMessages ?? []) {
    const invoke = /^Program (\w+) invoke/.exec(log);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(log)) {
      stack.pop();
      continue;
    }
    if (
      !log.startsWith("Program data: ") ||
      stack.at(-1) !== config.creditProgram
    )
      continue;
    const decoded = clientForMarket(marketId).credit.coder.events.decode(
      log.slice(14),
    );
    if (decoded?.data.market?.toBase58() === config.market) {
      const e = decoded.data;
      events.push({
        action: actionNames[e.action] ?? "Credit action",
        cash: display(big(e.assets), 6),
        collateral: display(big(e.collateral), 8),
        badDebt: display(big(e.badDebt), 6),
        owner: e.owner.toBase58(),
      });
    }
  }
  return {
    failed: !!tx.meta?.err,
    fee: (tx.meta?.fee ?? 0) / 1e9,
    slot: tx.slot,
    events,
    movements,
  };
}
