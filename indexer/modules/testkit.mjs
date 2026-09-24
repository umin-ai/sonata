// Test fixtures for the fee modules (no network): accounts as the chain stores
// them, built with the SDKs' own coders, and a small in-memory chain that
// applies the transfers, account creations, swaps and burns the modules send.
// Used only by indexer/modules/*.test.mjs and indexer/crank.test.mjs.
import anchor from "@coral-xyz/anchor";
import bs58 from "bs58";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  AccountState,
  AccountType,
  MINT_SIZE,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccountLen,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithMarketCap,
  getMigrationThresholdPrice,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CP_AMM_PROGRAM_ID, derivePositionNftAccount } from "@meteora-ag/cp-amm-sdk";
import { METADATA_PROGRAM, SONATA_VAULT } from "./common.mjs";
import { metadataAddress } from "./fee-model.mjs";
import { amm, dbcClient, graduatedPool } from "./meteora.mjs";
import { netByTrader } from "./top-buyers.mjs";

const { BN } = anchor;
export const key = () => Keypair.generate().publicKey;
// An off-curve address, as a program's PDA.
export const pda = (seed = "vault") => PublicKey.findProgramAddressSync([Buffer.from(seed)], key())[0];

export function tokenAccount({ owner, mint, amount = 0n, state = AccountState.Initialized, program = TOKEN_2022_PROGRAM_ID, extensions = [] }) {
  const size = extensions.length ? getAccountLen(extensions.map(([t]) => t)) : ACCOUNT_SIZE;
  const data = Buffer.alloc(size);
  AccountLayout.encode(
    {
      mint, owner, amount, state,
      delegateOption: 0, delegate: PublicKey.default, isNativeOption: 0, isNative: 0n,
      delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
    },
    data,
  );
  if (extensions.length) {
    data[ACCOUNT_SIZE] = AccountType.Account;
    let at = ACCOUNT_SIZE + 1;
    for (const [type, body = Buffer.alloc(0)] of extensions) {
      data.writeUInt16LE(type, at);
      data.writeUInt16LE(body.length, at + 2);
      body.copy(data, at + 4);
      at += 4 + body.length;
    }
  }
  return { data, owner: program, lamports: 2_039_280, executable: false };
}

export function mintAccount({ decimals, supply = 0n, program = TOKEN_PROGRAM_ID }) {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    { mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply, decimals, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default },
    data,
  );
  return { data, owner: program, lamports: 1, executable: false };
}

// Anchor's coder encodes into 1,000 bytes; DBC's config is larger.
function encode(coder, name, value, owner) {
  const layout = coder.accountLayouts.get(name);
  const buffer = Buffer.alloc(8192);
  const size = layout.layout.encode(value, buffer);
  return { data: Buffer.concat([Buffer.from(layout.discriminator), buffer.subarray(0, size)]), owner, lamports: 1, executable: false };
}
const blank = (coder, name) => coder.decode(name, Buffer.concat([Buffer.from(coder.accountDiscriminator(name)), Buffer.alloc(coder.size(name) - 8)]));

/** The curve Sonata's launch builds (lib/treasury/dbc-preview.ts), for market caps in quote tokens. */
export function sonataCurve({ initial = 30, target = 300, feeBps = 125 } = {}) {
  return buildCurveWithMarketCap({
    token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.EIGHT, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 50, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 50, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    initialMarketCap: initial,
    migrationMarketCap: target,
  });
}

/**
 * A market's DBC pool and config accounts, on a Sonata curve. `quoteReserve`
 * moves nothing else; `migrated` sets isMigrated and migrationProgress 3
 * (CreatedPool) unless `progress` says otherwise.
 */
export function dbcAccounts(m, { curve = sonataCurve(), quoteReserve = 0n, migrated = false, progress, edit } = {}) {
  const coder = dbcClient.pool.program.coder.accounts;
  const config = blank(coder, "poolConfig");
  Object.assign(config, {
    quoteMint: m.quoteMint, feeClaimer: SONATA_VAULT, collectFeeMode: 0, activationType: 1, migrationOption: 1,
    migrationFeeOption: curve.migrationFeeOption, quoteTokenFlag: 1, tokenType: 0, tokenDecimal: 6,
    migrationQuoteThreshold: curve.migrationQuoteThreshold, sqrtStartPrice: curve.sqrtStartPrice,
    migrationSqrtPrice: getMigrationThresholdPrice(curve.migrationQuoteThreshold, curve.sqrtStartPrice, curve.curve),
  });
  Object.assign(config.poolFees.baseFee, curve.poolFees.baseFee);
  curve.curve.forEach((p, i) => (config.curve[i] = p));
  const pool = blank(coder, "virtualPool");
  Object.assign(pool.poolState, {
    config: m.config, creator: m.creator ?? key(), baseMint: m.baseMint, baseVault: m.baseVault ?? key(), quoteVault: m.quoteVault ?? key(),
    sqrtPrice: curve.sqrtStartPrice, baseReserve: new BN("1000000000000000"), quoteReserve: new BN(quoteReserve.toString()),
    activationPoint: new BN(0), poolType: 0, isMigrated: migrated ? 1 : 0, migrationProgress: progress ?? (migrated ? 3 : 0),
  });
  edit?.({ config, pool: pool.poolState });
  return {
    poolInfo: encode(coder, "virtualPool", pool, dbcClient.pool.program.programId),
    configInfo: encode(coder, "poolConfig", config, dbcClient.pool.program.programId),
    config,
    curve,
  };
}

/** The graduated DAMM v2 pool of a market (base = token A, quote = token B). */
export function dammPoolAccount(m, { migrationFeeOption = 3, liquidity = "1000000000000000000000000", edit } = {}) {
  const coder = amm._program.coder.accounts;
  const p = blank(coder, "pool");
  Object.assign(p, {
    tokenAMint: m.baseMint, tokenBMint: m.quoteMint, tokenAVault: key(), tokenBVault: key(),
    liquidity: new BN(liquidity), sqrtPrice: new BN("18446744073709551616"), sqrtMinPrice: new BN("4295048016"),
    sqrtMaxPrice: new BN("79226673521066979257578248091"), activationType: 1, activationPoint: new BN(0), poolStatus: 0,
    collectFeeMode: 1, tokenAFlag: 0, tokenBFlag: 1,
  });
  edit?.(p);
  return { address: graduatedPool(m, { migrationFeeOption }), info: encode(coder, "pool", p, CP_AMM_PROGRAM_ID), state: p };
}

/** A DAMM v2 position and its NFT, held by `owner` in DAMM v2's own NFT account (or `nftAccount`). */
export function positionAccounts(dammPool, { owner, unlocked = 0n, permanent = 0n, vested = 0n, nftAccount } = {}) {
  const coder = amm._program.coder.accounts;
  const nftMint = key();
  const s = blank(coder, "position");
  Object.assign(s, {
    pool: dammPool, nftMint,
    unlockedLiquidity: new BN(unlocked.toString()), permanentLockedLiquidity: new BN(permanent.toString()), vestedLiquidity: new BN(vested.toString()),
  });
  const address = PublicKey.findProgramAddressSync([Buffer.from("position"), nftMint.toBuffer()], CP_AMM_PROGRAM_ID)[0];
  const holding = nftAccount ?? derivePositionNftAccount(nftMint);
  return {
    address,
    nftMint,
    info: encode(coder, "position", s, CP_AMM_PROGRAM_ID),
    nft: owner ? { address: holding, info: tokenAccount({ owner, mint: nftMint, amount: 1n, program: TOKEN_2022_PROGRAM_ID }) } : null,
  };
}

/** A Metaplex metadata account (MetadataV1: key, update authority, mint, name, symbol, uri). */
export function metadataAccount(mint, uri, { name = "Token", symbol = "TOK", pad = false } = {}) {
  const str = (s, len) => {
    const body = Buffer.from(s, "utf8");
    const padded = pad ? Buffer.concat([body, Buffer.alloc(Math.max(0, len - body.length))]) : body;
    const n = Buffer.alloc(4);
    n.writeUInt32LE(padded.length);
    return Buffer.concat([n, padded]);
  };
  const data = Buffer.concat([Buffer.from([4]), key().toBuffer(), mint.toBuffer(), str(name, 32), str(symbol, 10), str(uri, 200), Buffer.alloc(40)]);
  return { address: metadataAddress(mint), info: { data, owner: METADATA_PROGRAM, lamports: 1, executable: false } };
}

/** A fetch that serves `routes` (url → { status, body, headers }) and records requests. */
export function fakeFetch(routes = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404 });
    if (r.throws) throw Error(r.throws);
    const body = typeof r.body === "string" || r.body instanceof Uint8Array ? r.body : JSON.stringify(r.body);
    return new Response(body, { status: r.status ?? 200, headers: r.headers ?? { "content-type": "application/json" } });
  };
  return { fetchImpl, requests };
}

/** The in-memory ledger, as indexer/rewards.mjs pgLedger behaves. `trades` stand in for the trades table. */
export function memLedger({ trades = [] } = {}) {
  const payouts = [], pending = new Map(), models = new Map(), statuses = new Map();
  const airdrops = new Map(), drops = new Map();
  const rowsOf = (pool) => drops.get(pool) ?? drops.set(pool, new Map()).get(pool);
  return {
    payouts, pendingRows: pending, trades, models, statuses, airdrops, drops,
    // Graduation airdrop, as pgLedger's airdrop_state and airdrop_payouts.
    airdropEnsure: async (pool) => void (airdrops.has(pool) || airdrops.set(pool, { withdrawn: null, withdrawSignature: null, withdrawLastValidBlockHeight: null, snapshotAt: null, done: false, sentAt: null })),
    airdropState: async (pool) => (airdrops.has(pool) ? { ...airdrops.get(pool) } : null),
    airdropBeginWithdraw: async (pool, signature, lvbh) => {
      const s = airdrops.get(pool);
      if (s && s.withdrawn == null) Object.assign(s, { withdrawSignature: signature, withdrawLastValidBlockHeight: lvbh });
    },
    airdropClearWithdraw: async (pool) => {
      const s = airdrops.get(pool);
      if (s && s.withdrawn == null) Object.assign(s, { withdrawSignature: null, withdrawLastValidBlockHeight: null });
    },
    airdropWithdrawn: async (pool, amount, signature) => {
      const s = airdrops.get(pool);
      if (s && s.withdrawn == null) Object.assign(s, { withdrawn: amount, withdrawSignature: signature });
    },
    airdropSnapshot: async (pool, rows) => {
      const s = airdrops.get(pool);
      if (!s || s.snapshotAt || s.withdrawn == null) return;
      s.snapshotAt = new Date();
      const map = rowsOf(pool);
      for (const r of rows) if (!map.has(r.recipient.toBase58())) map.set(r.recipient.toBase58(), { recipient: r.recipient, owner: r.owner, amount: r.amount, status: "unpaid", signature: null, lastValidBlockHeight: null, sentAt: null });
    },
    airdropRows: async (pool) => [...rowsOf(pool).values()].map((r) => ({ ...r })).sort((a, b) => (a.amount === b.amount ? (a.recipient.toBase58() < b.recipient.toBase58() ? -1 : 1) : a.amount > b.amount ? -1 : 1)),
    airdropBeginSend: async (pool, recipients, signature, lvbh) => {
      const map = rowsOf(pool);
      const rows = recipients.map((k) => map.get(k.toBase58()));
      if (rows.some((r) => !r || r.status !== "unpaid")) throw Error("airdrop rows changed; nothing sent");
      for (const r of rows) Object.assign(r, { status: "pending", signature, lastValidBlockHeight: lvbh });
    },
    airdropSettle: async (pool, signature, status) => {
      for (const r of rowsOf(pool).values())
        if (r.signature === signature && r.status === "pending")
          Object.assign(r, status === "sent" ? { status, sentAt: new Date() } : { status: "unpaid", signature: null, lastValidBlockHeight: null });
    },
    airdropSkip: async (pool, recipient, note) => {
      const r = rowsOf(pool).get(recipient.toBase58());
      if (r?.status === "unpaid") Object.assign(r, { status: "skipped", note });
    },
    airdropDone: async (pool) => {
      const s = airdrops.get(pool);
      const rows = [...rowsOf(pool).values()];
      if (s?.snapshotAt && !rows.some((r) => r.status === "unpaid" || r.status === "pending")) Object.assign(s, { done: true, sentAt: rows.reduce((t, r) => (r.sentAt && (!t || r.sentAt > t) ? r.sentAt : t), null) });
    },
    airdropReserved: async (pool) => {
      const s = airdrops.get(pool);
      if (!s) return null;
      const sent = [...rowsOf(pool).values()].filter((r) => r.status === "sent").reduce((t, r) => t + r.amount, 0n);
      return { withdrawn: s.withdrawn, amount: s.withdrawn == null ? 0n : s.withdrawn - sent, unknown: s.withdrawn == null && s.withdrawSignature != null };
    },
    ready: async () => true,
    pending: async () => [...pending.values()],
    paid: async (pool) => [...payouts, ...pending.values()].filter((r) => r.pool === pool).reduce((s, r) => s + r.amount, 0n),
    begin: async (row) => void pending.set(row.signature, { ...row }),
    confirm: async (signature) => {
      const row = pending.get(signature);
      pending.delete(signature);
      if (row) payouts.push(row);
    },
    drop: async (signature) => void pending.delete(signature),
    feeModels: async (pools) => new Map(pools.filter((p) => models.has(p)).map((p) => [p, models.get(p)])),
    saveFeeModel: async ({ pool, ...entry }) => void (models.has(pool) || models.set(pool, entry)),
    setStatus: async (pool, status) => void statuses.set(pool, status),
    lastRoundEnd: async (pool) => {
      const ends = [...payouts, ...pending.values()].filter((r) => r.pool === pool && r.module === "topBuyers").map((r) => Number(r.detail.roundEnd));
      return ends.length ? Math.max(...ends) : null;
    },
    buyerNets: async (pool, start, end) => netByTrader(trades.filter((t) => t.pool === pool), { start, end }),
    tenure: async (pool, traders) => {
      const out = new Map();
      for (const t of trades) {
        if (t.pool !== pool || !traders.includes(t.trader)) continue;
        const time = Math.floor(new Date(t.block_time).getTime() / 1000);
        const r = out.get(t.trader) ?? { firstBuy: null, lastSell: null };
        if (t.side === "buy") r.firstBuy = r.firstBuy == null ? time : Math.min(r.firstBuy, time);
        else r.lastSell = r.lastSell == null ? time : Math.max(r.lastSell, time);
        out.set(t.trader, r);
      }
      return out;
    },
  };
}

const DBC = dbcClient.pool.program.programId;
const amountOf = (info) => AccountLayout.decode(info.data).amount;

/**
 * A chain of accounts that simulates and applies what the modules send:
 * Token-2022 transfer_checked, associated account creation, SPL burn_checked
 * and DBC / DAMM v2 swaps. A swap delivers `swapOut(amountIn, minOut)` base
 * atoms when simulated and `landOut(amountIn, minOut)` when sent (a price move
 * in between), and fails below its minimum out. By default it delivers what a
 * 2% minimum implies was quoted. `poison` accounts fail any instruction
 * touching them. `delivered` lists what each sent swap delivered. A send whose
 * signature, or 0-based send index, is in `lost` never lands. withdraw_leftover
 * credits `leftover` base atoms once.
 */
export const quotedOut = (_, minOut) => (minOut * 10_000n) / 9_800n;
const WITHDRAW_LEFTOVER = Buffer.from(dbcClient.pool.program.idl.instructions.find((i) => i.name === "withdrawLeftover").discriminator);
export function fakeChain({ accounts = new Map(), swapOut = quotedOut, landOut, poison = new Set(), slot = 1000, time = 1_900_000_000, leftover = 0n, lost = new Set() } = {}) {
  const calls = [], simulated = [], sent = [], delivered = [];
  let sends = 0, height = 10;
  const land = landOut ?? swapOut;
  const put = (k, info) => accounts.set(k.toBase58(), info);
  const adjust = (state, k, delta) => {
    const info = state.get(k.toBase58());
    if (!info) return `account ${k.toBase58()} missing`;
    const a = AccountLayout.decode(info.data);
    if (a.amount + delta < 0n) return "insufficient funds";
    a.amount += delta;
    const data = Buffer.from(info.data);
    AccountLayout.encode(a, data);
    state.set(k.toBase58(), { ...info, data });
    return null;
  };
  // Runs a transaction on a copy of the accounts; returns { err, state }.
  const execute = (instructions, out, record = () => {}) => {
    const state = new Map(accounts);
    for (const [index, ix] of instructions.entries()) {
      const fail = (why) => ({ err: { InstructionError: [index, { Custom: 1 }] }, logs: [`Program log: Error: ${why}`], state });
      if (ix.keys.some((k) => poison.has(k.pubkey.toBase58()))) return fail("poisoned");
      const p = ix.programId;
      let why = null;
      if ((p.equals(TOKEN_2022_PROGRAM_ID) || p.equals(TOKEN_PROGRAM_ID)) && ix.data[0] === 12) {
        const amount = ix.data.readBigUInt64LE(1);
        why = adjust(state, ix.keys[0].pubkey, -amount) ?? adjust(state, ix.keys[2].pubkey, amount);
      } else if (p.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 15) {
        why = adjust(state, ix.keys[0].pubkey, -ix.data.readBigUInt64LE(1));
      } else if (p.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
        const [, ata, owner, mint, , program] = ix.keys.map((k) => k.pubkey);
        if (!state.has(ata.toBase58())) state.set(ata.toBase58(), tokenAccount({ owner, mint, program }));
      } else if (p.equals(DBC) && ix.data.subarray(0, 8).equals(WITHDRAW_LEFTOVER)) {
        // withdraw_leftover: pool, then the receiver's base account, credited `leftover` once.
        const [, , pool, receiver] = ix.keys.map((k) => k.pubkey);
        const coder = dbcClient.pool.program.coder.accounts;
        const info = state.get(pool.toBase58());
        const vp = coder.decode("virtualPool", Buffer.from(info.data));
        if (vp.poolState.isWithdrawLeftover) why = "leftover already withdrawn";
        else {
          vp.poolState.isWithdrawLeftover = 1;
          state.set(pool.toBase58(), { ...info, ...encode(coder, "virtualPool", vp, info.owner) });
          why = adjust(state, receiver, leftover);
        }
      } else if (p.equals(DBC) || p.equals(CP_AMM_PROGRAM_ID)) {
        const amountIn = ix.data.readBigUInt64LE(8), minOut = ix.data.readBigUInt64LE(16);
        const [input, output] = p.equals(DBC) ? [ix.keys[3].pubkey, ix.keys[4].pubkey] : [ix.keys[2].pubkey, ix.keys[3].pubkey];
        const received = out(amountIn, minOut);
        record(received);
        why = received < minOut ? "exceeded slippage" : adjust(state, input, -amountIn) ?? adjust(state, output, received);
      }
      if (why) return fail(why);
    }
    return { err: null, logs: [], state };
  };
  const connection = {
    getMultipleAccountsInfo: async (keys) => (calls.push("getMultipleAccountsInfo"), keys.map((k) => accounts.get(k.toBase58()) ?? null)),
    getProgramAccounts: async (programId, config) => {
      calls.push(`getProgramAccounts ${programId.toBase58().slice(0, 6)}`);
      const filters = config?.filters ?? [];
      return [...accounts]
        .filter(([, info]) => info.owner.equals(programId))
        .filter(([, info]) =>
          filters.every((f) => (f.dataSize ? info.data.length === f.dataSize : Buffer.from(info.data).subarray(f.memcmp.offset).subarray(0, bs58.decode(f.memcmp.bytes).length).equals(Buffer.from(bs58.decode(f.memcmp.bytes))))),
        )
        .map(([k, account]) => ({ pubkey: new PublicKey(k), account }));
    },
    getTokenLargestAccounts: async (mint) => {
      calls.push("getTokenLargestAccounts");
      const value = [...accounts]
        .filter(([, i]) => (i.owner.equals(TOKEN_2022_PROGRAM_ID) || i.owner.equals(TOKEN_PROGRAM_ID)) && i.data.length >= ACCOUNT_SIZE && new PublicKey(i.data.subarray(0, 32)).equals(mint))
        .map(([k, i]) => ({ address: new PublicKey(k), amount: amountOf(i).toString() }));
      return { value };
    },
    getAccountInfo: async (k) => (calls.push("getAccountInfo"), accounts.get(k.toBase58()) ?? null),
    getSlot: async () => (calls.push("getSlot"), slot),
    getBlockTime: async () => (calls.push("getBlockTime"), time),
    simulateTransaction: async (vtx, opts) => {
      calls.push("simulateTransaction");
      const tx = Transaction.populate(vtx.message);
      simulated.push(tx.instructions);
      const r = execute(tx.instructions, swapOut);
      const value = { err: r.err, logs: r.logs, unitsConsumed: 60_000 };
      if (opts?.accounts)
        value.accounts = opts.accounts.addresses.map((a) => {
          const info = r.err ? null : r.state.get(a);
          return info ? { ...info, owner: info.owner.toBase58(), data: [Buffer.from(info.data).toString("base64"), "base64"] } : null;
        });
      return { value };
    },
    getLatestBlockhash: async () => (calls.push("getLatestBlockhash"), blockhash()),
    // A signature in `lost` is accepted but never lands (as a dropped transaction).
    sendRawTransaction: async (raw) => {
      calls.push("sendRawTransaction");
      const tx = Transaction.from(raw);
      const signature = bs58.encode(tx.signature);
      const n = sends++;
      if (lost.has(signature) || lost.has(n)) {
        lost.add(signature);
        return signature;
      }
      const got = [];
      const before = new Map(accounts);
      const r = execute(tx.instructions, land, (x) => got.push(x));
      if (!r.err) {
        for (const [k, v] of r.state) accounts.set(k, v);
        delivered.push(...got);
      }
      // Token balances as getTransaction reports them.
      const message = tx.compileMessage();
      const balances = (state) =>
        message.accountKeys.flatMap((k, accountIndex) => {
          const info = state.get(k.toBase58());
          if (!info || !(info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID)) || info.data.length < ACCOUNT_SIZE) return [];
          const a = AccountLayout.decode(info.data);
          return [{ accountIndex, mint: a.mint.toBase58(), owner: a.owner.toBase58(), uiTokenAmount: { amount: a.amount.toString() } }];
        });
      sent.push({
        tx, bytes: raw.length, signature, err: r.err,
        record: { slot, meta: { err: r.err, preTokenBalances: balances(before), postTokenBalances: balances(r.err ? before : accounts), innerInstructions: [] }, transaction: { message } },
      });
      return signature;
    },
    getTransaction: async (signature) => (calls.push("getTransaction"), sent.find((t) => t.signature === signature)?.record ?? null),
    getSignaturesForAddress: async (address) => (
      calls.push("getSignaturesForAddress"),
      sent.filter((t) => t.tx.compileMessage().accountKeys.some((k) => k.equals(address))).reverse().map((t) => ({ signature: t.signature, err: t.err }))
    ),
    getSignatureStatuses: async (signatures) => (
      calls.push("getSignatureStatuses"),
      { value: signatures.map((s) => { const x = sent.find((t) => t.signature === s); return x ? { err: x.err, confirmationStatus: "confirmed", slot } : null; }) }
    ),
    getBlockHeight: async () => (calls.push("getBlockHeight"), height),
    getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  };
  const balance = (k) => (accounts.get(k.toBase58()) ? amountOf(accounts.get(k.toBase58())) : null);
  // A fresh blockhash each time, valid for 150 blocks from the current height;
  // setHeight moves the height (so earlier blockhashes expire).
  let hashes = 0;
  const blockhash = async () => ({ blockhash: bs58.encode(Buffer.alloc(32, ++hashes)), lastValidBlockHeight: height + 150 });
  return { accounts, put, connection, calls, simulated, sent, delivered, balance, lost, blockhash, setHeight: (h) => (height = h) };
}

/**
 * A market whose payout owner is `crank`, with its quote mint, the crank's
 * funded quote account, and its base mint in `chain`.
 */
export function rewardMarket(chain, crank, { owed = 1_000_000n, held = owed, supply = 1_000_000_000_000_000n, quoteMint = key() } = {}) {
  const baseMint = key();
  const m = {
    pool: key(), config: key(), treasury: key(), quoteMint, baseMint, creator: key(), payoutOwner: crank,
    baseVault: key(), quoteVault: key(), treasuryBase: key(),
    payoutQuote: getAssociatedTokenAddressSync(quoteMint, crank, false, TOKEN_2022_PROGRAM_ID),
  };
  chain.put(quoteMint, mintAccount({ decimals: 8, program: TOKEN_2022_PROGRAM_ID }));
  chain.put(baseMint, mintAccount({ decimals: 6, supply }));
  chain.put(m.payoutQuote, tokenAccount({ owner: crank, mint: quoteMint, amount: held }));
  return m;
}

/** A module's context, as payRewards builds it, over a fakeChain. */
export async function moduleContext({ chain, m, authority, owed, ledger = memLedger(), dryRun = false, model = { feeModel: "holders" }, feePayer, now = () => 1_900_000_000_000, excludedOwners }) {
  const { payShares } = await import("./payout.mjs");
  const lines = [];
  const rpc = (fn) => fn();
  const fetchAll = (keys) => chain.connection.getMultipleAccountsInfo(keys);
  const snapshot = new Map((await fetchAll([m.baseMint, m.quoteMint, m.payoutQuote])).map((info, i) => [[m.baseMint, m.quoteMint, m.payoutQuote][i].toBase58(), info]));
  const ctx = {
    m, owed, model, ledger, dryRun, now, rpc, fetchAll,
    fund: { balance: chain.balance(m.payoutQuote) ?? 0n, owed },
    line: { pool: m.pool.toBase58(), model: model.feeModel, owed },
    result: { paid: 0n, recipients: 0, txs: 0, simulated: 0, skipped: {} },
    fields: {},
    authority,
    connection: chain.connection,
    get: (k) => snapshot.get(k.toBase58()) ?? null,
    feePayer: feePayer ?? authority.publicKey,
    deadline: Infinity,
    pollMs: 0,
    log: (tag, f) => lines.push({ tag, ...f }),
    lines,
    excludedOwners: excludedOwners ?? [authority.publicKey],
    blockhash: chain.blockhash,
    simulate: async (steps, payer, { accounts } = {}) => {
      const tx = new Transaction().add(...steps.map((s) => s.ix));
      tx.feePayer = payer;
      tx.recentBlockhash = PublicKey.default.toBase58();
      return (await chain.connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), accounts ? { accounts: { encoding: "base64", addresses: accounts.map(String) } } : {})).value;
    },
  };
  ctx.payShares = (shares, opts) => payShares(ctx, shares, opts);
  ctx.payHolders = async (opts) => {
    ctx.heldBy = opts;
    return {};
  };
  return ctx;
}

export { BN };
