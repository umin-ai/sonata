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

// ---- Allocation rounds, balance snapshots, the LP NFT cache ------------------

/**
 * Adds pgLedger's allocation rounds (reward_allocations), balance snapshots
 * and LP position-NFT cache to an in-memory ledger (memLedger by default),
 * behaving as pgLedger does: begin marks a transaction's allocation rows
 * pending in the same step (or throws and writes nothing), confirm pays them,
 * drop makes them unpaid again. Returns the same ledger, with every row in
 * `allocationRows` and the snapshots in `snapshots`. Adding them twice is a no-op.
 */
export function payoutLedger(ledger = memLedger()) {
  if (ledger.allocationRows) return ledger;
  const rows = [], snapshots = new Map(), nfts = new Map();
  let checks = 0;
  const base = { begin: ledger.begin, confirm: ledger.confirm, drop: ledger.drop };
  const unpaid = (pool) => rows.filter((r) => r.pool === pool && r.status === "unpaid");
  const view = (r) => ({ round: r.round, recipient: r.recipient, kind: r.kind, module: r.module, amount: r.amount, weight: r.weight });
  const series = (pool, kind) => snapshots.get(`${pool}|${kind}`) ?? snapshots.set(`${pool}|${kind}`, new Map()).get(`${pool}|${kind}`);
  const byAmount = (a, b) => (a.amount === b.amount ? a.round - b.round || (a.recipient < b.recipient ? -1 : 1) : a.amount > b.amount ? -1 : 1);
  return Object.assign(ledger, {
    allocationRows: rows,
    snapshots,
    nftCache: nfts,
    allocatedUnpaid: async (pool) => unpaid(pool).reduce((s, r) => s + r.amount, 0n),
    allocations: async (pool) => unpaid(pool).sort(byAmount).map(view),
    allocate: async (pool, { module, shares }) => {
      const round = rows.filter((r) => r.pool === pool).reduce((n, r) => Math.max(n, r.round), 0) + 1;
      const added = shares.map((s) => ({ pool, round, module, ...s, status: "unpaid", signature: null, paidTo: null, createsAccount: false }));
      if (new Set(added.map((r) => r.recipient)).size !== added.length || added.some((r) => r.amount <= 0n)) throw Error("bad allocation round");
      rows.push(...added);
      return added.map(view);
    },
    createdAccounts: async (pool) =>
      new Set(rows.filter((r) => r.pool === pool && r.createsAccount && r.status !== "unpaid").map((r) => r.paidTo ?? r.recipient)),
    begin: async (row) => {
      const { allocations, ...rest } = row;
      if (allocations?.length) {
        const found = allocations.map((a) => rows.find((r) => r.pool === row.pool && r.round === a.round && r.recipient === a.recipient && r.status === "unpaid"));
        if (found.some((r) => !r) || found.reduce((s, r) => s + r.amount, 0n) !== row.amount) throw Error("allocation rows changed; nothing sent");
        found.forEach((r, i) => Object.assign(r, { status: "pending", signature: row.signature, paidTo: allocations[i].paidTo, createsAccount: Boolean(allocations[i].creates) }));
      }
      return base.begin(rest);
    },
    confirm: async (signature) => {
      await base.confirm(signature);
      for (const r of rows) if (r.signature === signature && r.status === "pending") r.status = "paid";
    },
    drop: async (signature) => {
      await base.drop(signature);
      for (const r of rows)
        if (r.signature === signature && r.status === "pending") Object.assign(r, { status: "unpaid", signature: null, paidTo: null, createsAccount: false });
    },
    recordSnapshot: async (pool, kind, at, entries) => {
      const s = series(pool, kind);
      if (!s.has(at)) s.set(at, new Map(entries.map(([h, a]) => [h, BigInt(a)])));
    },
    pruneSnapshots: async (pool, kind, keep, at) => {
      const s = series(pool, kind);
      const old = [...s.keys()].filter((t) => t <= at - keep);
      if (old.length) for (const t of [...s.keys()]) if (t < Math.max(...old)) s.delete(t);
    },
    previousSnapshot: async (pool, kind, at) => {
      const s = series(pool, kind);
      const before = [...s.keys()].filter((t) => t < at);
      if (!before.length) return null;
      const t = Math.max(...before);
      return { takenAt: t, amounts: new Map(s.get(t)) };
    },
    heldMinimums: async (pool, kind, holders, at, windows) => {
      const s = series(pool, kind);
      const out = new Map();
      for (const d of windows) {
        const old = [...s.keys()].filter((t) => t <= at - d);
        if (!old.length) continue;
        const since = Math.max(...old);
        const span = [...s.keys()].filter((t) => t >= since && t < at);
        for (const h of holders) {
          if (!span.every((t) => s.get(t).has(h))) continue;
          const low = span.map((t) => s.get(t).get(h)).reduce((a, b) => (b < a ? b : a));
          (out.get(h) ?? out.set(h, new Map()).get(h)).set(d, low);
        }
      }
      return out;
    },
    nftHolders: async (mints) => new Map(mints.filter((k) => nfts.has(k)).map((k) => [k, { ...nfts.get(k) }])),
    saveNftHolder: async (mint, { account, owner }) => void nfts.set(mint, { account, owner, checkedAt: ++checks }),
  });
}

/**
 * A module context for one pass over `m`, as payRewards builds it: owedTotal
 * is `distributed` less what `ledger` has paid (pending included), ctx.owed
 * that less what allocation rounds hold unpaid, with the real holders module
 * (payHolders) and ctx.minAtoms (default 1). Other options as moduleContext.
 */
export async function passContext({ chain, m, authority, distributed, ledger, minAtoms = 1n, ...rest }) {
  const { payHolders } = await import("./holders.mjs");
  const pool = m.pool.toBase58();
  const owedTotal = BigInt(distributed) - (await ledger.paid(pool));
  const carried = await ledger.allocatedUnpaid(pool);
  const ctx = await moduleContext({ chain, m, authority, owed: owedTotal - carried, ledger, ...rest });
  Object.assign(ctx, { owedTotal, carried, minAtoms, fund: { balance: chain.balance(m.payoutQuote) ?? 0n, owed: owedTotal } });
  ctx.line.owed = owedTotal;
  ctx.payHolders = (opts) => payHolders(ctx, opts);
  return ctx;
}

/** A classic SPL token account of the market's base token, held by `owner` (a holder). */
export function holdBase(chain, m, owner, amount, address = key()) {
  chain.put(address, tokenAccount({ owner, mint: m.baseMint, amount, program: TOKEN_PROGRAM_ID }));
  return address;
}

/** Gives `owner` an empty Token-2022 quote account (its associated one) for the market's quote mint. */
export function quoteAccount(chain, m, owner, over = {}) {
  const address = getAssociatedTokenAddressSync(m.quoteMint, owner, false, TOKEN_2022_PROGRAM_ID);
  chain.put(address, tokenAccount({ owner, mint: m.quoteMint, ...over }));
  return address;
}

/**
 * One payRewards call over `markets` on `chain`, as the crank makes it:
 * treasury totals from `distributed` (atoms, or a Map pool → atoms), fee
 * models from `ledger` (set ledger.models first), `now` for the modules.
 * Returns { out, lines }.
 */
export async function rewardsPass({ chain, markets, authority, ledger, distributed, minAtoms = 1n, now = Date.now, dryRun = false, deadline = Infinity, excluded = [] }) {
  const { payRewards } = await import("../rewards.mjs");
  const lines = [];
  const simulate = async (steps, payer) => {
    const tx = new Transaction().add(...steps.map((s) => s.ix));
    tx.feePayer = payer;
    tx.recentBlockhash = PublicKey.default.toBase58();
    return (await chain.connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {})).value;
  };
  const totalOf = (m) => BigInt(distributed instanceof Map ? distributed.get(m.pool.toBase58()) : distributed);
  const out = await payRewards({
    markets, authority, connection: chain.connection, rpc: (fn) => fn(), simulate, blockhash: chain.blockhash, ledger,
    readTreasury: (_, m) => ({ totalDistributed: totalOf(m) }),
    minAtoms, dryRun, deadline, pollMs: 0, now, excluded, log: (tag, f) => lines.push({ tag, ...f }),
    fetchImpl: async () => new Response("not found", { status: 404 }),
  });
  return { out, lines };
}

// ---- DAMM v2 swap transactions (indexer/parse.test.mjs, indexer/index.test.mjs) ----
import { CpAmmIdl } from "@meteora-ag/cp-amm-sdk";

// Anchor's event-CPI instruction tag: EVENT_IX_TAG 0x1d9acb512ea545e4, little-endian.
const ANCHOR_EVENT_TAG = Buffer.from("e445a52e51cb9a1d", "hex");
const DAMM_SWAP2 = CpAmmIdl.instructions.find((i) => i.name === "swap2");
const DAMM_EVT_SWAP2 = CpAmmIdl.events.find((e) => e.name.toLowerCase() === "evtswap2");

/**
 * A DAMM v2 swap2 as getTransaction's JSON returns it, with its EvtSwap2 event
 * CPI built from the SDK's IDL layout. direction 1 = BtoA (quote in: a buy),
 * 0 = AtoB (base in: a sell). `payer` is the swap's payer account, `feePayer`
 * the transaction's; `routed` puts the swap inside another program's
 * instruction (as an aggregator does). `result` overrides swap_result fields
 * (bigints).
 */
export function dammSwapTx({ direction, pool = key(), feePayer = key(), payer = feePayer, routed = false, result = {}, slot = 500_000_000, blockTime = 1_790_000_000, signature = "s" }) {
  const r = {
    included_fee_input_amount: 1_000_000n, excluded_fee_input_amount: 987_500n, amount_left: 0n, output_amount: 49_000_000n,
    next_sqrt_price: 2n ** 64n, claiming_fee: 10_000n, protocol_fee: 2_500n, compounding_fee: 0n, referral_fee: 0n, ...result,
  };
  const body = new anchor.BorshCoder(CpAmmIdl).types.encode(DAMM_EVT_SWAP2.name, {
    pool, trade_direction: direction, collect_fee_mode: 1, has_referral: false,
    params: { amount_0: new BN(1_000_000), amount_1: new BN(0), swap_mode: 0 },
    swap_result: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, new BN(v.toString())])),
    included_transfer_fee_amount_in: new BN(0), included_transfer_fee_amount_out: new BN(0), excluded_transfer_fee_amount_out: new BN(0),
    current_timestamp: new BN(blockTime), reserve_a_amount: new BN(1), reserve_b_amount: new BN(1),
  });
  const event = bs58.encode(Buffer.concat([ANCHOR_EVENT_TAG, Buffer.from(DAMM_EVT_SWAP2.discriminator), body]));
  const swapData = bs58.encode(Buffer.concat([Buffer.from(DAMM_SWAP2.discriminator), Buffer.alloc(17)]));
  // Account keys: the fee payer first, then whatever the instructions use.
  const keys = [feePayer.toBase58()];
  const at = (k) => (keys.includes(k) ? keys.indexOf(k) : keys.push(k) - 1);
  const swapAccounts = DAMM_SWAP2.accounts.map((a) => at(a.name === "pool" ? pool.toBase58() : a.name === "payer" ? payer.toBase58() : key().toBase58()));
  const damm = at(CP_AMM_PROGRAM_ID.toBase58()), token = at(TOKEN_PROGRAM_ID.toBase58());
  const h = routed ? 3 : 2;
  const transfer = { accounts: [swapAccounts[2], swapAccounts[4], swapAccounts[8]], data: "3Bxs4Bc3VYuGVB19", programIdIndex: token, stackHeight: h };
  const swap = { accounts: swapAccounts, data: swapData, programIdIndex: damm };
  const top = routed ? { accounts: [at(key().toBase58())], data: "1", programIdIndex: at(key().toBase58()) } : swap;
  const inner = [
    ...(routed ? [{ ...swap, stackHeight: 2 }] : []),
    transfer,
    { ...transfer },
    { accounts: [at(key().toBase58())], data: event, programIdIndex: damm, stackHeight: h },
  ];
  return {
    blockTime, slot, version: "legacy",
    meta: { err: null, innerInstructions: [{ index: 1, instructions: inner }], loadedAddresses: { writable: [], readonly: [] } },
    transaction: {
      message: { accountKeys: keys, header: {}, instructions: [{ accounts: [], data: "3", programIdIndex: at("ComputeBudget111111111111111111111111111111") }, top] },
      signatures: [signature],
    },
  };
}

// ---- Appended for the crank review fixes -------------------------------------

/**
 * A profile on Sonata's CDN as lib/server/s3-upload.ts names it (tokens/<sha256
 * of the bytes>.json) and the fakeFetch route that serves exactly those bytes.
 * `body` is an object (served as JSON.stringify(body), as fakeFetch does) or a string.
 */
export async function cdnProfile(body) {
  const { createHash } = await import("node:crypto");
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const uri = `https://d3lwm4c3ge2mv2.cloudfront.net/tokens/${createHash("sha256").update(text).digest("hex")}.json`;
  return { uri, route: { body: text } };
}

/**
 * Adds indexer/modules/crank-schema.mjs crankLedger's fee model failure record
 * to `ledger` (in place), on the clock `now` (ms). `ledger.failures` holds the rows.
 */
export function withFeeModelFailures(ledger, { now = () => Date.now() } = {}) {
  const failures = new Map();
  return Object.assign(ledger, {
    failures,
    feeModelFailure: async (pool, reason) => {
      const at = now();
      const row = failures.get(pool) ?? { firstFailedAt: at, failures: 0 };
      Object.assign(row, { lastFailedAt: at, failures: row.failures + 1, lastError: reason });
      failures.set(pool, row);
      return { firstFailedAt: new Date(row.firstFailedAt), failures: row.failures, elapsedMs: at - row.firstFailedAt };
    },
  });
}

// ---- Appended for the payout-bot review fixes (LP Farm, Top Buyer, holders) ----

/**
 * Adds pgLedger's LP Farm reads to a payoutLedger (in place; payoutLedger()
 * by default): lastRoundAt (rounds are stamped `createdAt` from
 * ledger.clock(), unix seconds, when allocated), heldSince over the balance
 * snapshots, releaseAllocations, and the last NFT holder of positions
 * (positionHolders, savePositionHolders; kept in `positionOwners`). Set
 * ledger.clock to move its time. Adding them twice is a no-op.
 */
export function lpFarmLedger(ledger = payoutLedger(), { clock = () => Math.floor(Date.now() / 1000) } = {}) {
  payoutLedger(ledger);
  if (ledger.heldSince) return ledger;
  const rows = ledger.allocationRows;
  const owners = new Map();
  const inner = ledger.allocate;
  const view = (r) => ({ round: r.round, recipient: r.recipient, kind: r.kind, module: r.module, amount: r.amount, weight: r.weight });
  return Object.assign(ledger, {
    clock,
    positionOwners: owners,
    allocate: async (pool, args) => {
      const added = await inner(pool, args);
      const at = ledger.clock();
      for (const r of rows) if (r.pool === pool && r.round === added[0]?.round) r.createdAt ??= at;
      return added;
    },
    lastRoundAt: async (pool, module) => {
      const times = rows.filter((r) => r.pool === pool && r.module === module && r.createdAt != null).map((r) => r.createdAt);
      return times.length ? Math.max(...times) : null;
    },
    heldSince: async (pool, kind, since, at, holders) => {
      const s = ledger.snapshots.get(`${pool}|${kind}`) ?? new Map();
      const times = [...s.keys()].filter((t) => t < at).sort((a, b) => a - b);
      const upTo = since == null ? [] : times.filter((t) => t <= since);
      const from = upTo.length ? upTo.at(-1) : times[0];
      const span = from === undefined ? [] : times.filter((t) => t >= from);
      const lows = new Map();
      for (const h of holders) {
        if (!span.length || !span.every((t) => s.get(t).has(h))) continue;
        lows.set(h, span.map((t) => s.get(t).get(h)).reduce((a, b) => (b < a ? b : a)));
      }
      return { snapshots: span.length, lows };
    },
    releaseAllocations: async (pool, { kind, recipients, olderThanSeconds }) => {
      const cutoff = ledger.clock() - olderThanSeconds;
      const gone = rows.filter((r) => r.pool === pool && r.kind === kind && r.status === "unpaid" && recipients.includes(r.recipient) && (r.createdAt ?? Infinity) <= cutoff);
      for (const r of gone) rows.splice(rows.indexOf(r), 1);
      return gone.map(view);
    },
    positionHolders: async (positions) => new Map(positions.filter((p) => owners.has(p)).map((p) => [p, { ...owners.get(p) }])),
    savePositionHolders: async (pool, entries) => {
      for (const [position, owner] of entries) owners.set(position, { pool, owner, seenAt: ledger.clock() });
    },
  });
}

/** Rewrites a DAMM v2 position account in `chain` (edit gets its decoded state); edit returning null closes the account. */
export function editPosition(chain, address, edit) {
  const coder = amm._program.coder.accounts;
  const s = coder.decode("position", Buffer.from(chain.accounts.get(address.toBase58()).data));
  if (edit(s) === null) return void chain.accounts.delete(address.toBase58());
  chain.put(address, encode(coder, "position", s, CP_AMM_PROGRAM_ID));
}

/** getTokenAccountsByOwner(owner, { mint }) as the RPC answers it, added to a fakeChain's connection (it has none). */
export function withOwnerLookup(chain) {
  chain.connection.getTokenAccountsByOwner = async (owner, { mint }) => {
    chain.calls.push("getTokenAccountsByOwner");
    const value = [...chain.accounts]
      .filter(([, i]) => (i.owner.equals(TOKEN_PROGRAM_ID) || i.owner.equals(TOKEN_2022_PROGRAM_ID)) && i.data.length >= ACCOUNT_SIZE)
      .filter(([, i]) => new PublicKey(i.data.subarray(0, 32)).equals(mint) && new PublicKey(i.data.subarray(32, 64)).equals(owner))
      .map(([k, account]) => ({ pubkey: new PublicKey(k), account }));
    return { context: { slot: 1 }, value };
  };
  return chain;
}

// ---- Appended for the Top Buyer Bounty fixes ---------------------------------

import { netBaseOf } from "./top-buyers.mjs";

/**
 * Adds pgLedger's netBase to an in-memory ledger: each wallet's signed net
 * base in [start, end) from the ledger's `trades`, as
 * modules/indexer-schema.mjs netBase reads the trades table. Adding it twice
 * is a no-op.
 */
export function withNetBase(ledger) {
  ledger.netBase ??= async (pool, traders, start, end) => netBaseOf((ledger.trades ?? []).filter((t) => t.pool === pool), traders, { start, end });
  return ledger;
}

// Every in-memory ledger answers netBase, as pgLedger does: memLedger (and so
// the default ledger of payoutLedger, lpFarmLedger and moduleContext) comes
// with it.
const memLedgerWithoutNetBase = memLedger;
memLedger = (options) => withNetBase(memLedgerWithoutNetBase(options));

// ---- The indexer's LP readings (indexer/index.mjs lpReadings) ----------------

/**
 * A db answering indexer/index.mjs lpReadings' queries as PostgreSQL would,
 * over `ledger`'s balance snapshots (payoutLedger or lpFarmLedger), so the
 * crank's modules see the indexer's readings. `markets` stand in for pools
 * joined with market_fee_models: { pool, damm_pool, fee_model }. Every query
 * is kept in `queries` (whitespace collapsed).
 */
export function lpReadingDb(ledger, markets = []) {
  const queries = [];
  async function query(sql, args = []) {
    const s = sql.replace(/\s+/g, " ").trim();
    queries.push({ sql: s, args });
    if (s.startsWith("select p.pool, p.damm_pool from pools p join market_fee_models f on f.pool = p.pool where f.fee_model = 'lpFarm' and p.damm_pool is not null order by p.pool"))
      return {
        rows: markets
          .filter((m) => m.fee_model === "lpFarm" && m.damm_pool != null)
          .map(({ pool, damm_pool }) => ({ pool, damm_pool }))
          .sort((a, b) => (a.pool < b.pool ? -1 : 1)),
      };
    if (s.startsWith("select holder from balance_snapshot_rows where pool = $1 and kind = 'lp' and taken_at = (select max(taken_at) from balance_snapshots where pool = $1 and kind = 'lp')")) {
      const series = ledger.snapshots.get(`${args[0]}|lp`);
      if (!series?.size) return { rows: [] };
      return { rows: [...series.get(Math.max(...series.keys())).keys()].sort().map((holder) => ({ holder })) };
    }
    if (s.startsWith("with taken as ( insert into balance_snapshots (pool, kind, taken_at) values ($1, 'lp', to_timestamp($2::double precision)) on conflict do nothing returning taken_at)")) {
      await ledger.recordSnapshot(args[0], "lp", args[1], args[2].map((h, i) => [h, BigInt(args[3][i])]));
      return { rows: [], rowCount: args[2].length };
    }
    if (s.startsWith("delete from balance_snapshots where pool = $1 and kind = 'lp' and taken_at < (select max(taken_at) from balance_snapshots where pool = $1 and kind = 'lp' and taken_at <= to_timestamp($2::double precision) - $3::int * interval '1 second')")) {
      await ledger.pruneSnapshots(args[0], "lp", args[2], args[1]);
      return { rows: [] };
    }
    throw Error(`unexpected query: ${s}`);
  }
  return { query, queries };
}
