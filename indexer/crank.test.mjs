import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import anchor from "@coral-xyz/anchor";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  AccountState,
  MINT_SIZE,
  MintLayout,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  buildSteps,
  claimGraduatedIx,
  destinationState,
  modeOf,
  planMarket,
  runPass,
  txBytes,
  vaultAdmin,
  DEVNET_GENESIS,
  MAX_TX_BYTES,
  SPLIT_MODES,
  PHASE_ENDS_MS,
  rotation,
} from "./crank.mjs";
import { netByTrader } from "./modules/top-buyers.mjs";
import * as kit from "./modules/testkit.mjs";
import { DAMM_EVENT_AUTHORITY, DAMM_POOL_AUTHORITY, graduatedAccounts, vaultPosition } from "./modules/graduated.mjs";
import { graduatedPool } from "./modules/meteora.mjs";

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const treasuryIdl = json("../lib/treasury/stockroom_treasury.json");
const program = new anchor.Program(treasuryIdl, { connection: new Connection("http://127.0.0.1:1") });
const marketJson = json("../lib/treasury/market.json");
const market = (over = {}) => ({
  ...Object.fromEntries(
    ["treasury", "pool", "config", "quoteMint", "baseMint", "payoutOwner", "treasuryBase", "treasuryQuote", "payoutQuote", "baseVault", "quoteVault"]
      .map((k) => [k, new PublicKey(marketJson[k])]),
  ),
  mode: "refrain",
  ...over,
});
// A standard market paying Sonata's share to `admin`'s Token-2022 quote account.
const splitMarket = (mode = "standard", admin = Keypair.generate().publicKey, over = {}) => {
  const m = market({ mode, ...over });
  return {
    ...m,
    platformOwner: admin,
    platformQuote: getAssociatedTokenAddressSync(m.quoteMint, admin, true, TOKEN_2022_PROGRAM_ID),
  };
};
const tokenAccount = (owner, mint, state = AccountState.Initialized, amount = 0n, programId = TOKEN_2022_PROGRAM_ID) => {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return { data, owner: programId, lamports: 2_039_280, executable: false };
};

const state = (over = {}) => ({
  partnerQuoteFee: 0n,
  unallocated: 0n,
  treasuryBaseReady: true,
  payoutAccount: "ok",
  migrated: false,
  ...over,
});

test("nothing to do when no fees accrued and nothing is unallocated", () => {
  const plan = planMarket(state());
  assert.deepEqual(plan, { claim: false, claimGraduated: false, distribute: false, createPayout: false, createPlatform: false, reason: "nothing to claim or distribute" });
});

test("claims only when the partner fee reaches the threshold", () => {
  const below = planMarket(state({ partnerQuoteFee: 9_999n }), 10_000n);
  assert.equal(below.claim, false);
  assert.equal(below.distribute, false);
  assert.match(below.reason, /below 10000/);
  const at = planMarket(state({ partnerQuoteFee: 10_000n }), 10_000n);
  assert.equal(at.claim, true);
  // A threshold of 0 never claims an empty pool.
  assert.equal(planMarket(state(), 0n).claim, false);
});

test("distributes whatever is unallocated, even below the claim threshold", () => {
  const plan = planMarket(state({ partnerQuoteFee: 5n, unallocated: 1n }), 10_000n);
  assert.deepEqual(plan, { claim: false, claimGraduated: false, distribute: true, createPayout: false, createPlatform: false, reason: null });
});

test("claim and distribute together once fees reach the threshold", () => {
  for (const unallocated of [0n, 250n]) {
    const plan = planMarket(state({ partnerQuoteFee: 240_000n, unallocated }));
    assert.deepEqual(plan, { claim: true, claimGraduated: false, distribute: true, createPayout: false, createPlatform: false, reason: null });
  }
});

test("creates a missing payout account only when distributing", () => {
  assert.equal(planMarket(state({ unallocated: 10n, payoutAccount: "missing" })).createPayout, true);
  assert.equal(planMarket(state({ payoutAccount: "missing" })).createPayout, false);
});

test("a frozen payout account blocks distribute but not claim", () => {
  const plan = planMarket(state({ partnerQuoteFee: 20_000n, payoutAccount: "frozen" }));
  assert.equal(plan.claim, true);
  assert.equal(plan.distribute, false);
  assert.match(plan.reason, /frozen/);
});

test("a missing treasury base account blocks claim but not distribute", () => {
  const plan = planMarket(state({ partnerQuoteFee: 20_000n, unallocated: 7n, treasuryBaseReady: false }));
  assert.equal(plan.claim, false);
  assert.equal(plan.distribute, true);
  assert.match(plan.reason, /cannot claim/);
});

test("migrated pools are still tried", () => {
  assert.equal(planMarket(state({ partnerQuoteFee: 20_000n, migrated: true })).claim, true);
});

test("claim, payout account creation and distribute fit in one transaction", async () => {
  const m = market();
  const payer = Keypair.generate().publicKey;
  const steps = await buildSteps(m, { claim: true, claimGraduated: false, distribute: true, createPayout: true }, payer);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0].map((s) => s.label), ["compute budget", "claim", "create payout account", "distribute"]);
  const bytes = txBytes(steps[0].map((s) => s.ix), payer);
  assert.ok(bytes <= MAX_TX_BYTES, `${bytes} bytes`);
  // The instruction set never includes the fee payer as a writable fund destination.
  const [, claim, , distribute] = steps[0].map((s) => s.ix);
  assert.ok(!claim.keys.some((k) => k.pubkey.equals(payer)));
  assert.ok(!distribute.keys.some((k) => k.pubkey.equals(payer)));
  assert.ok(distribute.keys.some((k) => k.pubkey.equals(m.payoutQuote) && k.isWritable));
});

test("reads every mode the app launches; sustain and unknown modes are skipped", () => {
  assert.equal(modeOf({ refrain: {} }), "refrain");
  assert.equal(modeOf({ duet: {} }), "duet");
  assert.equal(modeOf({ floor: {} }), "floor");
  assert.equal(modeOf({ standard: {} }), "standard");
  assert.equal(modeOf({ standardFloor: {} }), "standardFloor");
  assert.equal(modeOf({ sustain: {} }), null);
  assert.equal(modeOf({}), null);
  assert.deepEqual([...SPLIT_MODES], ["standard", "standardFloor"]);
  // The IDL this crank builds from has the variants it reads, in onchain order.
  const variants = treasuryIdl.types.find((t) => t.name === "Mode").type.variants.map((v) => v.name);
  assert.deepEqual(variants, ["Refrain", "Duet", "Sustain", "Floor", "Standard", "StandardFloor"]);
});

test("the platform account is created when missing and a frozen one blocks the split", () => {
  const missing = planMarket(state({ unallocated: 10n, platformAccount: "missing" }));
  assert.deepEqual(missing, { claim: false, claimGraduated: false, distribute: true, createPayout: false, createPlatform: true, reason: null });
  assert.equal(planMarket(state({ platformAccount: "missing" })).createPlatform, false);
  const frozen = planMarket(state({ partnerQuoteFee: 20_000n, unallocated: 5n, platformAccount: "frozen" }));
  assert.equal(frozen.claim, true);
  assert.equal(frozen.distribute, false);
  assert.match(frozen.reason, /platform token account frozen/);
  // Modes without a platform share never create one.
  assert.equal(planMarket(state({ unallocated: 10n })).createPlatform, false);
});

test("platform modes use distribute_split, and the worst case still fits one transaction", async () => {
  const payer = Keypair.generate().publicKey;
  for (const mode of ["standard", "standardFloor"]) {
    const m = splitMarket(mode);
    const steps = await buildSteps(m, { claim: true, claimGraduated: false, distribute: true, createPayout: true, createPlatform: true }, payer);
    assert.equal(steps.length, 1);
    assert.deepEqual(steps[0].map((s) => s.label), [
      "compute budget",
      "claim",
      "create payout account",
      "create platform account",
      "distribute_split",
    ]);
    const bytes = txBytes(steps[0].map((s) => s.ix), payer);
    assert.ok(bytes <= MAX_TX_BYTES, `${bytes} bytes`);
    const [, claim, createPayout, createPlatform, split] = steps[0].map((s) => s.ix);
    // The platform account is the Vault admin's Token-2022 associated account.
    assert.ok(createPlatform.keys[1].pubkey.equals(m.platformQuote));
    assert.ok(createPlatform.keys[2].pubkey.equals(m.platformOwner));
    assert.ok(createPlatform.keys.some((k) => k.pubkey.equals(TOKEN_2022_PROGRAM_ID)));
    assert.ok(createPayout.keys[1].pubkey.equals(m.payoutQuote));
    // Account order as the IDL declares it: vault, treasury, custody, payout, platform, mint, token program.
    const expected = [m.treasury, m.treasuryQuote, m.payoutQuote, m.platformQuote, m.quoteMint, TOKEN_2022_PROGRAM_ID];
    assert.deepEqual(split.keys.slice(1).map((k) => k.pubkey.toBase58()), expected.map((k) => k.toBase58()));
    assert.ok(split.keys[0].pubkey.equals(PublicKey.findProgramAddressSync([Buffer.from("stockroom")], program.programId)[0]));
    assert.deepEqual(split.keys.map((k) => k.isWritable), [false, true, true, true, true, false, false]);
    assert.ok(split.data.subarray(0, 8).equals(Buffer.from(treasuryIdl.instructions.find((i) => i.name === "distribute_split").discriminator)));
    for (const ix of [claim, split]) assert.ok(!ix.keys.some((k) => k.pubkey.equals(payer)));
  }
});

test("a payout owner who is the Vault admin gets one account, created once", async () => {
  const admin = Keypair.generate().publicKey;
  const m = splitMarket("standard", admin, {
    payoutOwner: admin,
    payoutQuote: getAssociatedTokenAddressSync(new PublicKey(marketJson.quoteMint), admin, true, TOKEN_2022_PROGRAM_ID),
  });
  assert.ok(m.payoutQuote.equals(m.platformQuote));
  const steps = await buildSteps(m, { claim: false, claimGraduated: false, distribute: true, createPayout: true, createPlatform: true }, admin);
  assert.deepEqual(steps[0].map((s) => s.label), ["compute budget", "create payout account", "distribute_split"]);
});

test("a platform-mode split is never built without the Vault admin's account", async () => {
  const m = market({ mode: "standardFloor" });
  await assert.rejects(buildSteps(m, { claim: false, claimGraduated: false, distribute: true }, Keypair.generate().publicKey), /platform account unknown/);
  // A claim alone does not need it.
  const steps = await buildSteps(m, { claim: true, claimGraduated: false, distribute: false }, Keypair.generate().publicKey);
  assert.deepEqual(steps[0].map((s) => s.label), ["compute budget", "claim"]);
});

test("the Vault admin is read only from the treasury program's Vault account", async () => {
  const admin = Keypair.generate().publicKey;
  const data = await program.coder.accounts.encode("vault", { admin, bump: 255, treasuries: new anchor.BN(3) });
  const info = { data, owner: program.programId, lamports: 1, executable: false };
  assert.ok(vaultAdmin(info).equals(admin));
  assert.throws(() => vaultAdmin(null), /missing or not owned/);
  assert.throws(() => vaultAdmin({ ...info, owner: Keypair.generate().publicKey }), /missing or not owned/);
  // A treasury account (another discriminator) is not a Vault.
  assert.throws(() => vaultAdmin({ ...info, data: Buffer.concat([Buffer.alloc(8), data.subarray(8)]) }), /vault/);
  const none = await program.coder.accounts.encode("vault", { admin: PublicKey.default, bump: 255, treasuries: new anchor.BN(0) });
  assert.throws(() => vaultAdmin({ ...info, data: none }), /no admin/);
});

test("destination accounts must belong to the pinned owner and the quote mint", () => {
  const owner = Keypair.generate().publicKey,
    mint = new PublicKey(marketJson.quoteMint),
    address = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
  assert.equal(destinationState("platform token account", address, null, owner, mint), "missing");
  assert.equal(destinationState("platform token account", address, tokenAccount(owner, mint), owner, mint), "ok");
  assert.equal(destinationState("platform token account", address, tokenAccount(owner, mint, AccountState.Frozen), owner, mint), "frozen");
  assert.throws(
    () => destinationState("platform token account", address, tokenAccount(Keypair.generate().publicKey, mint), owner, mint),
    /platform token account verification failed/,
  );
  assert.throws(
    () => destinationState("platform token account", address, tokenAccount(owner, Keypair.generate().publicKey), owner, mint),
    /platform token account verification failed/,
  );
});

// A whole pass against a fake RPC: accounts are built as the chain holds them.
const dbcIdl = json("../lib/treasury/dbc.json");
const dbcCoder = new anchor.BorshAccountsCoder(dbcIdl);
const [VAULT] = PublicKey.findProgramAddressSync([Buffer.from("stockroom")], program.programId);
const QUOTE = new PublicKey(marketJson.quoteMint);
const dbcAccount = (name, edit) => {
  const layout = dbcCoder.accountLayouts.get(name);
  const decoded = dbcCoder.decode(name, Buffer.concat([Buffer.from(layout.discriminator), Buffer.alloc(dbcCoder.size(name) - 8)]));
  edit(decoded.poolState ?? decoded);
  const buffer = Buffer.alloc(4096);
  const size = layout.layout.encode(decoded, buffer);
  return { data: Buffer.concat([Buffer.from(layout.discriminator), buffer.subarray(0, size)]), owner: new PublicKey(dbcIdl.address), lamports: 1, executable: false };
};
const quoteMintAccount = () => {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    { mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 8, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default },
    data,
  );
  return { data, owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false };
};
const baseMintAccount = (supply) => {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    { mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default },
    data,
  );
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
};
const quoteAta = (owner) => getAssociatedTokenAddressSync(QUOTE, owner, true, TOKEN_2022_PROGRAM_ID);
// `distributed` is the treasury's lifetime payout (as a Standard market books
// it: platform share retained and withdrawn), `payoutBalance` what the payout
// quote account holds, and `holders` the base token's wallets
// ({ owner, amount, quote: has a quote account }).
async function addMarket(accounts, rows, {
  mode, fee = 20_000n, payoutExists = true, platformOwner, platformExists = false,
  payoutOwner = Keypair.generate().publicKey, distributed = 0n, payoutBalance = 0n,
  supply = 2_000_000_000n, holders = [], vaultHolding = 0n, treasuryHolding = 0n, graduated = null, leftoverReceiver,
}) {
  const pool = Keypair.generate().publicKey,
    config = Keypair.generate().publicKey,
    baseMint = Keypair.generate().publicKey,
    creator = Keypair.generate().publicKey,
    baseVault = Keypair.generate().publicKey;
  const [treasury] = PublicKey.findProgramAddressSync([Buffer.from("treasury"), pool.toBuffer()], program.programId);
  const zero = new anchor.BN(0), bn = (v) => new anchor.BN(String(v));
  const data = await program.coder.accounts.encode("treasury", {
    pool, config, quoteMint: QUOTE, baseMint, creator, payoutOwner, mode: { [mode]: {} }, bump: 255,
    totalClaimed: bn(2n * distributed), totalDistributed: bn(distributed), totalRetained: bn(distributed), totalWithdrawn: bn(distributed), lastClaimTs: zero,
  });
  const treasuryAccount = { data, owner: program.programId, lamports: 1, executable: false };
  rows.push({ pubkey: treasury, account: treasuryAccount });
  const put = (k, v) => accounts.set(k.toBase58(), v);
  put(treasury, treasuryAccount);
  put(pool, dbcAccount("virtualPool", (p) => {
    Object.assign(p, { config, baseMint, creator, baseVault, quoteVault: Keypair.generate().publicKey, partnerQuoteFee: new anchor.BN(String(fee)) });
    // Graduated to DAMM v2 (MigrationProgress 3 = CreatedPool).
    if (graduated) Object.assign(p, { isMigrated: 1, migrationProgress: 3 });
  }));
  let damm = null;
  if (graduated) {
    // The graduated DAMM v2 pool (migration fee option 0) and the Vault's locked position in it.
    damm = kit.dammPoolAccount({ baseMint, quoteMint: QUOTE }, { migrationFeeOption: 0 });
    put(damm.address, damm.info);
    const position = kit.positionAccounts(damm.address, { owner: VAULT, permanent: 10n ** 20n });
    put(position.address, position.info);
    put(position.nft.address, position.nft.info);
    damm.position = position;
  }
  put(config, dbcAccount("poolConfig", (c) => Object.assign(c, { feeClaimer: VAULT, quoteMint: QUOTE, ...(leftoverReceiver ? { leftoverReceiver } : {}) })));
  put(baseMint, baseMintAccount(supply));
  // Its Metaplex metadata, with no profile uri: a holders token (modules/fee-model.mjs).
  const md = kit.metadataAccount(baseMint, "");
  put(md.address, md.info);
  const treasuryBase = getAssociatedTokenAddressSync(baseMint, treasury, true, TOKEN_PROGRAM_ID);
  const treasuryBaseAccount = tokenAccount(treasury, baseMint, AccountState.Initialized, treasuryHolding, TOKEN_PROGRAM_ID);
  put(treasuryBase, treasuryBaseAccount);
  put(getAssociatedTokenAddressSync(QUOTE, treasury, true, TOKEN_2022_PROGRAM_ID), tokenAccount(treasury, QUOTE));
  if (payoutExists) put(quoteAta(payoutOwner), tokenAccount(payoutOwner, QUOTE, AccountState.Initialized, payoutBalance));
  if (platformExists) put(quoteAta(platformOwner), tokenAccount(platformOwner, QUOTE));
  // The base mint's classic token accounts, as getProgramAccounts returns them.
  // The pool's base vault is owned by a signing wallet here, so only its address excludes it.
  const tokens = [{ pubkey: treasuryBase, account: treasuryBaseAccount }];
  if (vaultHolding)
    tokens.push({ pubkey: baseVault, account: tokenAccount(Keypair.generate().publicKey, baseMint, AccountState.Initialized, vaultHolding, TOKEN_PROGRAM_ID) });
  for (const h of holders) {
    tokens.push({ pubkey: Keypair.generate().publicKey, account: tokenAccount(h.owner, baseMint, AccountState.Initialized, h.amount, TOKEN_PROGRAM_ID) });
    if (h.quote) put(quoteAta(h.owner), tokenAccount(h.owner, QUOTE));
  }
  return { pool, treasury, payoutOwner, baseMint, tokens, damm };
}
// The reward ledger in memory, as indexer/rewards.mjs pgLedger behaves.
// `trades` stand in for the indexer's trades table.
function memLedger({ trades = [] } = {}) {
  const payouts = [], pending = new Map(), models = new Map(), statuses = new Map();
  return kit.payoutLedger({
    payouts,
    trades,
    models,
    statuses,
    pending: async () => [...pending.values()],
    pendingRows: pending,
    ready: async () => true,
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
      const ends = [...payouts, ...pending.values()].filter((r) => r.pool === pool && r.module === "topBuyers").map((r) => r.detail.roundEnd);
      return ends.length ? Math.max(...ends) : null;
    },
    buyerNets: async (pool, start, end) => netByTrader(trades.filter((t) => t.pool === pool), { start, end }),
  });
}
// Moves quote atoms as a sent Token-2022 transfer_checked would.
function applyTransfers(accounts, tx) {
  for (const ix of tx.instructions) {
    if (!ix.programId.equals(TOKEN_2022_PROGRAM_ID) || ix.data[0] !== 12) continue;
    const amount = ix.data.readBigUInt64LE(1);
    const edit = (k, delta) => {
      const info = accounts.get(k.toBase58());
      const a = AccountLayout.decode(info.data);
      a.amount += delta;
      assert.ok(a.amount >= 0n, "transfer exceeds the source balance");
      const data = Buffer.from(info.data);
      AccountLayout.encode(a, data);
      accounts.set(k.toBase58(), { ...info, data });
    };
    edit(ix.keys[0].pubkey, -amount);
    edit(ix.keys[2].pubkey, amount);
  }
}
// `onLog` sees every line as it is logged (a test's clock can move on it).
async function fakeChain({ markets, vaultAdminKey, payer = Keypair.generate(), funded = false, dryRun = true, ledger = null, poison = new Set(), rewardMinAtoms, graduatedFee = 0n, onLog = () => {} }) {
  const accounts = new Map([[QUOTE.toBase58(), quoteMintAccount()]]);
  if (funded) accounts.set(payer.publicKey.toBase58(), { data: Buffer.alloc(0), owner: SystemProgram.programId, lamports: 1_000_000_000, executable: false });
  if (vaultAdminKey)
    accounts.set(VAULT.toBase58(), {
      data: await program.coder.accounts.encode("vault", { admin: vaultAdminKey, bump: 255, treasuries: new anchor.BN(markets.length) }),
      owner: program.programId,
      lamports: 1,
      executable: false,
    });
  const rows = [];
  const added = [];
  for (const m of markets)
    added.push(await addMarket(accounts, rows, { platformOwner: vaultAdminKey, ...m, ...(m.reward ? { payoutOwner: payer.publicKey } : {}) }));
  const tokens = added.flatMap((a) => a.tokens);
  const calls = [];
  const simulated = [];
  const sent = [];
  const connection = {
    getGenesisHash: async () => (calls.push("getGenesisHash"), DEVNET_GENESIS),
    getProgramAccounts: async (programId, config) => {
      if (!programId.equals(TOKEN_PROGRAM_ID)) return calls.push("getProgramAccounts"), rows;
      calls.push("getProgramAccounts token");
      assert.ok(config.filters.some((f) => f.dataSize === 165));
      const mint = config.filters.find((f) => f.memcmp?.offset === 0).memcmp.bytes;
      return tokens.filter((t) => new PublicKey(t.account.data.subarray(0, 32)).toBase58() === mint);
    },
    getAccountInfo: async (k) => (calls.push(`getAccountInfo ${k.toBase58()}`), accounts.get(k.toBase58()) ?? null),
    getMultipleAccountsInfo: async (keys) => (calls.push("getMultipleAccountsInfo"), keys.map((k) => accounts.get(k.toBase58()) ?? null)),
    // A transaction touching a `poison` account fails at that instruction.
    simulateTransaction: async (tx, opts) => {
      calls.push("simulateTransaction");
      const keys = tx.message.staticAccountKeys;
      const ixs = tx.message.compiledInstructions.map((ix) => ({
        program: keys[ix.programIdIndex],
        accounts: ix.accountKeyIndexes.map((i) => keys[i]),
        data: Buffer.from(ix.data),
      }));
      simulated.push(ixs);
      const bad = ixs.findIndex((ix) => ix.accounts.some((k) => poison.has(k.toBase58())));
      if (bad >= 0) return { value: { err: { InstructionError: [bad, { Custom: 1 }] }, logs: ["Program log: Error: poisoned"], unitsConsumed: 0 } };
      // claim_graduated moves `graduatedFee` quote atoms into the treasury's quote account (its 7th account).
      const credit = new Map();
      for (const ix of ixs)
        if (ix.program.equals(program.programId) && ix.data.subarray(0, 8).equals(disc("claim_graduated")))
          credit.set(ix.accounts[6].toBase58(), graduatedFee);
      const value = { err: null, logs: [], unitsConsumed: 60_000 };
      if (opts?.accounts)
        value.accounts = opts.accounts.addresses.map((a) => {
          const info = accounts.get(a);
          if (!info) return null;
          const t = AccountLayout.decode(info.data);
          t.amount += credit.get(a) ?? 0n;
          const data = Buffer.from(info.data);
          AccountLayout.encode(t, data);
          return { ...info, owner: info.owner.toBase58(), data: [data.toString("base64"), "base64"] };
        });
      return { value };
    },
    getTokenAccountsByOwner: async (owner, { programId }) => (
      calls.push("getTokenAccountsByOwner"),
      { value: [...accounts].filter(([, i]) => i.owner.equals(programId) && i.data.length >= ACCOUNT_SIZE && new PublicKey(i.data.subarray(32, 64)).equals(owner)).map(([k, account]) => ({ pubkey: new PublicKey(k), account })) }
    ),
    getMultipleAccountsInfoAndContext: async (keys) => (calls.push("getMultipleAccountsInfo"), { context: { slot: 1 }, value: keys.map((k) => accounts.get(k.toBase58()) ?? null) }),
    getLatestBlockhash: async () => (calls.push("getLatestBlockhash"), { blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 1000 }),
    sendRawTransaction: async (raw) => {
      calls.push("sendRawTransaction");
      const tx = Transaction.from(raw);
      applyTransfers(accounts, tx);
      sent.push({ tx, bytes: raw.length, signature: bs58.encode(tx.signature) });
      return bs58.encode(tx.signature);
    },
    getSignatureStatuses: async (signatures) => (
      calls.push("getSignatureStatuses"),
      { value: signatures.map((s) => (sent.some((x) => x.signature === s) ? { err: null, confirmationStatus: "confirmed" } : null)) }
    ),
    getBlockHeight: async () => (calls.push("getBlockHeight"), 10),
  };
  const lines = [];
  const pass = (over = {}) =>
    runPass({ connection, payer, dryRun, spacingMs: 0, confirmPollMs: 0, ledger, rewardMinAtoms, log: (l) => (lines.push(l), onLog(l)), ...over });
  const counts = await pass();
  return { counts, calls, simulated, lines, added, sent, accounts, pass };
}
const disc = (name) => Buffer.from(treasuryIdl.instructions.find((i) => i.name === name).discriminator);

test("a pass claims and splits a platform market into the Vault admin's account, creating it", async () => {
  const admin = Keypair.generate().publicKey;
  const chain = await fakeChain({ markets: [{ mode: "standardFloor" }, { mode: "refrain" }], vaultAdminKey: admin });
  assert.deepEqual(chain.counts, { markets: 2, sent: 0, simulated: 2, skipped: 0, failed: 0 });
  // The Vault is read once, before the batched account fetch.
  assert.deepEqual(chain.calls, [
    "getGenesisHash",
    "getProgramAccounts",
    `getAccountInfo ${VAULT.toBase58()}`,
    "getMultipleAccountsInfo",
    "simulateTransaction",
    "simulateTransaction",
  ]);
  // Markets are walked in a rotating order: tell the two apart by their instructions.
  const isSplit = (ixs) => ixs.some((ix) => ix.data.subarray(0, 8).equals(disc("distribute_split")));
  const split = chain.simulated.find(isSplit), legacy = chain.simulated.find((ixs) => !isSplit(ixs));
  const platformQuote = getAssociatedTokenAddressSync(QUOTE, admin, true, TOKEN_2022_PROGRAM_ID);
  const treasuryIxs = (ixs) => ixs.filter((ix) => ix.program.equals(program.programId)).map((ix) => ix.data.subarray(0, 8));
  assert.deepEqual(treasuryIxs(split), [disc("claim"), disc("distribute_split")]);
  assert.deepEqual(treasuryIxs(legacy), [disc("claim"), disc("distribute")]);
  const creates = split.filter((ix) => ix.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert.equal(creates.length, 1);
  assert.ok(creates[0].accounts[1].equals(platformQuote));
  assert.ok(creates[0].accounts[2].equals(admin));
  const splitIx = split.find((ix) => ix.data.subarray(0, 8).equals(disc("distribute_split")));
  assert.ok(splitIx.accounts[0].equals(VAULT));
  assert.ok(splitIx.accounts[4].equals(platformQuote));
  const line = chain.lines.find((l) => l.includes("mode=standardFloor"));
  assert.match(line, /action=claim\+distribute_split/);
  assert.match(line, /platformAta=create/);
  assert.match(line, /result=simulated/);
  assert.ok(!chain.lines.find((l) => l.includes("mode=refrain")).includes("platformAta"));
});

test("an existing platform account is reused, and a pass with no platform market never reads the Vault", async () => {
  const admin = Keypair.generate().publicKey;
  const reuse = await fakeChain({ markets: [{ mode: "standard", platformExists: true }], vaultAdminKey: admin });
  assert.equal(reuse.counts.simulated, 1);
  assert.ok(!reuse.simulated[0].some((ix) => ix.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)));
  const legacy = await fakeChain({ markets: [{ mode: "refrain" }, { mode: "floor" }], vaultAdminKey: admin });
  assert.equal(legacy.counts.simulated, 2);
  assert.ok(!legacy.calls.some((c) => c.startsWith("getAccountInfo")));
});

test("without a readable Vault the platform markets fail and the others still run", async () => {
  const chain = await fakeChain({ markets: [{ mode: "standard" }, { mode: "duet" }], vaultAdminKey: null });
  assert.deepEqual(chain.counts, { markets: 2, sent: 0, simulated: 1, skipped: 0, failed: 1 });
  assert.match(chain.lines.find((l) => l.includes("mode=standard")), /action=fail reason="vault: Sonata Vault account missing/);
  assert.equal(chain.simulated.length, 1);
});

// ---- Reward tokens: markets whose payout owner is the crank key -------------

const wallet = () => Keypair.generate().publicKey;
const offCurve = () => PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], wallet())[0];
const balanceOf = (chain, owner) => AccountLayout.decode(chain.accounts.get(quoteAta(owner).toBase58()).data).amount;
// Transfers in a sent transaction: [destination, amount].
const transfersOf = (tx) =>
  tx.instructions
    .filter((ix) => ix.programId.equals(TOKEN_2022_PROGRAM_ID) && ix.data[0] === 12)
    .map((ix) => [ix.keys[2].pubkey.toBase58(), ix.data.readBigUInt64LE(1)]);
const rewardTxs = (chain) => chain.sent.filter((s) => transfersOf(s.tx).length);

test("a reward market's holders are paid pro rata; no quote account, PDAs, the pool vault, the treasury and the crank are skipped", async () => {
  const payer = Keypair.generate(), ledger = memLedger();
  const [h1, h2, h3, tiny] = [wallet(), wallet(), wallet(), wallet()];
  const chain = await fakeChain({
    payer, funded: true, dryRun: false, ledger, vaultAdminKey: wallet(),
    markets: [
      { mode: "refrain" },
      {
        mode: "standard", reward: true, fee: 0n, distributed: 1_000_000n, payoutBalance: 1_000_000n,
        vaultHolding: 900_000_000n, treasuryHolding: 30_000_000n,
        holders: [
          { owner: h1, amount: 400_000_000n, quote: true },
          { owner: h2, amount: 300_000_000n, quote: true },
          { owner: h3, amount: 200_000_000n, quote: false },
          { owner: offCurve(), amount: 50_000_000n, quote: true },
          { owner: payer.publicKey, amount: 20_000_000n },
          // 0.01% of the 2e9 supply is 200000.
          { owner: tiny, amount: 199_999n, quote: true },
        ],
      },
    ],
  });
  const pool = chain.added[1].pool.toBase58();
  // The ordinary market still claims and distributes; the reward market has nothing to claim.
  assert.equal(chain.counts.sent, 1);
  assert.deepEqual(chain.counts.rewards, { markets: 1, txs: 1, atoms: 999_999n, recipients: 2, simulated: 0, skipped: 0, failed: 0 });
  // owed 1000000 over 4:3 of the 700000000 held by holders who can be paid: h3 has no quote account, so no share.
  const [tx] = rewardTxs(chain);
  assert.deepEqual(transfersOf(tx.tx), [[quoteAta(h1).toBase58(), 571_428n], [quoteAta(h2).toBase58(), 428_571n]]);
  assert.ok(tx.tx.feePayer.equals(payer.publicKey));
  for (const ix of tx.tx.instructions) {
    assert.ok(ix.keys[0].pubkey.equals(quoteAta(payer.publicKey)));
    assert.ok(ix.keys[3].pubkey.equals(payer.publicKey) && ix.keys[3].isSigner);
  }
  assert.equal(balanceOf(chain, payer.publicKey), 1n);
  assert.deepEqual(ledger.payouts.map(({ pool: p, amount, recipients, signature }) => ({ p, amount, recipients, signature })), [
    { p: pool, amount: 999_999n, recipients: 2, signature: tx.signature },
  ]);
  assert.equal(ledger.pendingRows.size, 0);
  const paid = chain.lines.find((l) => l.startsWith("reward "));
  assert.match(paid, new RegExp(`^reward pool=${pool} sig=${tx.signature} amount=999999 recipients=2 bytes=\\d+ result=paid$`));
  assert.match(chain.lines.find((l) => l.startsWith("rewards ")), /action=pay holders=3 payable=2 noAta=1 paidNow=999999 recipients=2 txs=1 left=1/);
  assert.match(chain.lines.at(-1), /^summary .*rewardMarkets=1 rewardTxs=1 rewardAtoms=999999 rewardFailed=0/);
});

test("later passes pay only what is still owed; a holder without a quote account gets no share, and nothing below REWARD_MIN_ATOMS", async () => {
  const payer = Keypair.generate(), ledger = memLedger();
  const [h1, h2, h3] = [wallet(), wallet(), wallet()];
  const chain = await fakeChain({
    payer, funded: true, dryRun: false, ledger, vaultAdminKey: wallet(),
    markets: [{
      mode: "standard", reward: true, fee: 0n, distributed: 1_000_000n, payoutBalance: 1_000_000n,
      holders: [
        { owner: h1, amount: 400_000_000n, quote: true },
        { owner: h2, amount: 300_000_000n, quote: true },
        { owner: h3, amount: 200_000_000n, quote: false },
      ],
    }],
  });
  const total = () => ledger.payouts.reduce((s, r) => s + r.amount, 0n);
  // h3 had no quote account when the round was allocated: h1 and h2 shared all of it, and no row waits for h3.
  assert.equal(total(), 999_999n);
  assert.ok(!ledger.allocationRows.some((r) => r.recipient === h3.toBase58()));
  // Second pass: 1 atom owed, below the 100000 default.
  chain.accounts.set(quoteAta(h3).toBase58(), tokenAccount(h3, QUOTE));
  const second = await chain.pass();
  assert.deepEqual({ ...second.rewards, markets: undefined }, { markets: undefined, txs: 0, atoms: 0n, recipients: 0, simulated: 0, skipped: 1, failed: 0 });
  assert.match(chain.lines.findLast((l) => l.startsWith("rewards ")), /owed=1 action=skip reason="owed below 100000"/);
  assert.deepEqual([h1, h2, h3].map((h) => balanceOf(chain, h)), [571_428n, 428_571n, 0n]);
  // A lower threshold tries it; never more than the treasury distributed.
  await chain.pass({ rewardMinAtoms: 1n });
  assert.ok(total() <= 1_000_000n);
  assert.equal(balanceOf(chain, payer.publicKey), 1_000_000n - total());
  assert.equal(balanceOf(chain, h1) + balanceOf(chain, h2) + balanceOf(chain, h3), total());
});

test("an underfunded crank quote account pays nobody", async () => {
  const ledger = memLedger();
  const chain = await fakeChain({
    funded: true, dryRun: false, ledger, vaultAdminKey: wallet(),
    markets: [{ mode: "standard", reward: true, fee: 0n, distributed: 1_000_000n, payoutBalance: 999_999n, holders: [{ owner: wallet(), amount: 400_000_000n, quote: true }] }],
  });
  assert.equal(chain.counts.rewards.failed, 1);
  assert.equal(rewardTxs(chain).length, 0);
  assert.equal(ledger.payouts.length, 0);
  assert.match(chain.lines.find((l) => l.startsWith("rewards ")), /crank quote balance 999999 is below the 1000000 owed/);
});

test("without DATABASE_URL reward payouts are skipped and the pass still runs", async () => {
  const chain = await fakeChain({
    vaultAdminKey: wallet(),
    markets: [{ mode: "refrain" }, { mode: "standard", reward: true, distributed: 1_000_000n, payoutBalance: 1_000_000n }],
  });
  assert.equal(chain.counts.failed, 0);
  assert.equal(chain.counts.simulated, 2);
  assert.equal(chain.counts.rewards.skipped, 1);
  assert.equal(chain.counts.rewards.failed, 0);
  assert.ok(chain.lines.includes('rewards action=skip markets=1 reason="DATABASE_URL not set; reward payouts need the ledger"'));
  assert.ok(!chain.calls.includes("getProgramAccounts token"));
});

test("many holders are paid in batches that each fit in 1,232 bytes", async () => {
  const ledger = memLedger();
  const holders = Array.from({ length: 45 }, () => ({ owner: wallet(), amount: 10_000_000n, quote: true }));
  const chain = await fakeChain({
    funded: true, dryRun: false, ledger, vaultAdminKey: wallet(),
    markets: [{ mode: "standard", reward: true, fee: 0n, distributed: 1_000_000n, payoutBalance: 1_000_000n, holders }],
  });
  const txs = rewardTxs(chain);
  assert.deepEqual(txs.map((t) => transfersOf(t.tx).length), [20, 20, 5]);
  for (const t of txs) assert.ok(t.bytes <= MAX_TX_BYTES, `${t.bytes} bytes`);
  assert.equal(txs[0].bytes, 1210);
  // 1000000 / 45 = 22222 each; the 10 left over stays owed.
  assert.deepEqual(ledger.payouts.map((r) => [r.amount, r.recipients]), [[444_440n, 20], [444_440n, 20], [111_110n, 5]]);
  assert.equal(chain.lines.filter((l) => l.startsWith("reward ")).length, 3);
});

test("a recipient that fails simulation is dropped and the rest are paid; one market failing does not stop another", async () => {
  const ledger = memLedger();
  const good = [wallet(), wallet()];
  const broken = Array.from({ length: 6 }, wallet);
  const poison = new Set([good[1], ...broken].map((owner) => quoteAta(owner).toBase58()));
  const chain = await fakeChain({
    funded: true, dryRun: false, ledger, poison, vaultAdminKey: wallet(),
    markets: [
      // Six broken quote accounts: more than the five retries, so this market fails.
      { mode: "standard", reward: true, fee: 0n, distributed: 600_000n, payoutBalance: 0n,
        holders: broken.map((owner) => ({ owner, amount: 100_000_000n, quote: true })) },
      { mode: "standard", reward: true, fee: 0n, distributed: 1_000_000n, payoutBalance: 1_600_000n,
        holders: [...good, wallet()].map((owner) => ({ owner, amount: 100_000_000n, quote: true })) },
    ],
  });
  const [first, second] = chain.added.map((a) => a.pool.toBase58());
  assert.equal(chain.counts.rewards.failed, 1);
  assert.equal(chain.counts.rewards.txs, 1);
  assert.match(chain.lines.find((l) => l.startsWith(`rewards pool=${first}`)), /action=fail .*rejected=5 .*reason="simulation failed/);
  assert.match(chain.lines.find((l) => l.startsWith(`rewards pool=${second}`)), /action=pay holders=3 payable=3 rejected=1 paidNow=666666 recipients=2 txs=1 left=333334/);
  assert.deepEqual(ledger.payouts.map((r) => r.pool), [second]);
  assert.ok(!transfersOf(rewardTxs(chain)[0].tx).some(([to]) => to === quoteAta(good[1]).toBase58()));
});

test("a payout still pending from an earlier pass counts as paid", async () => {
  const ledger = memLedger();
  const chain = await fakeChain({
    funded: true, dryRun: true, ledger, vaultAdminKey: wallet(),
    markets: [{ mode: "standard", reward: true, fee: 0n, distributed: 1_000_000n, payoutBalance: 1_000_000n, holders: [{ owner: wallet(), amount: 400_000_000n, quote: true }] }],
  });
  // A crash after sending: the row is pending and its signature not yet seen, blockhash still valid.
  const pool = chain.added[0].pool.toBase58();
  await ledger.begin({ signature: bs58.encode(Buffer.alloc(64, 1)), pool, amount: 950_000n, recipients: 1, lastValidBlockHeight: 50 });
  const next = await chain.pass({ dryRun: false });
  assert.equal(next.rewards.skipped, 1);
  assert.equal(rewardTxs(chain).length, 0);
  assert.match(chain.lines.findLast((l) => l.startsWith("rewards ")), /owed=50000 action=skip/);
  assert.ok(chain.lines.some((l) => /^reward pool=\S+ sig=\S+ amount=950000 recipients=1 result=pending$/.test(l)));
});

test("a dry run simulates the first reward batch as the creator and writes nothing", async () => {
  const ledger = memLedger();
  const holders = Array.from({ length: 25 }, () => ({ owner: wallet(), amount: 10_000_000n, quote: true }));
  const chain = await fakeChain({
    ledger, vaultAdminKey: wallet(),
    markets: [{ mode: "standard", reward: true, fee: 0n, distributed: 1_000_000n, payoutBalance: 1_000_000n, holders }],
  });
  assert.equal(chain.counts.rewards.simulated, 1);
  assert.equal(chain.sent.length, 0);
  assert.equal(ledger.payouts.length + ledger.pendingRows.size, 0);
  // Two signers (creator pays the fee, the crank key authorizes): 18 transfers fit.
  const transfers = chain.simulated.at(-1).filter((ix) => ix.program.equals(TOKEN_2022_PROGRAM_ID));
  assert.equal(transfers.length, 18);
  assert.match(chain.lines.find((l) => l.startsWith("reward ")), /owed=1000000 result=simulated amount=720000 recipients=18 bytes=1208 units=60000 batches=2$/);
});

// ---- Fee modules, end to end: metadata JSON → fee model → module ------------

// A pass over one or more reward markets on the modules' test chain
// (indexer/modules/testkit.mjs), whose swaps, burns, transfers and account
// creations are applied as sent. Each market: { feeModel, json, owed, dbc }.
async function modulePass({ markets, trades = [], routes = {}, dryRun = false, ledger = kit.memLedger({ trades }) }) {
  kit.payoutLedger(ledger);
  const payer = Keypair.generate();
  const chain = kit.fakeChain();
  const admin = wallet();
  chain.put(payer.publicKey, { data: Buffer.alloc(0), owner: SystemProgram.programId, lamports: 1_000_000_000, executable: false });
  chain.put(VAULT, { data: await program.coder.accounts.encode("vault", { admin, bump: 255, treasuries: new anchor.BN(1) }), owner: program.programId, lamports: 1, executable: false });
  const added = [];
  for (const [i, spec] of markets.entries()) {
    const owed = spec.owed ?? 100_000_000n;
    const m = kit.rewardMarket(chain, payer.publicKey, { owed, held: owed, quoteMint: QUOTE });
    const [treasury] = PublicKey.findProgramAddressSync([Buffer.from("treasury"), m.pool.toBuffer()], program.programId);
    const bn = (v) => new anchor.BN(String(v));
    const data = await program.coder.accounts.encode("treasury", {
      pool: m.pool, config: m.config, quoteMint: QUOTE, baseMint: m.baseMint, creator: m.creator, payoutOwner: payer.publicKey, mode: { standard: {} }, bump: 255,
      totalClaimed: bn(2n * owed), totalDistributed: bn(owed), totalRetained: bn(owed), totalWithdrawn: bn(owed), lastClaimTs: bn(0),
    });
    chain.put(treasury, { data, owner: program.programId, lamports: 1, executable: false });
    const dbc = kit.dbcAccounts(m, spec.dbc);
    chain.put(m.pool, dbc.poolInfo);
    chain.put(m.config, dbc.configInfo);
    chain.put(getAssociatedTokenAddressSync(QUOTE, treasury, true, TOKEN_2022_PROGRAM_ID), kit.tokenAccount({ owner: treasury, mint: QUOTE }));
    // Named by the SHA-256 of what is served there, as Sonata's uploads are.
    const { uri } = await kit.cdnProfile(spec.profile ?? spec.json?.body ?? { name: "T", sonata: { feeModel: spec.feeModel } });
    const md = kit.metadataAccount(m.baseMint, uri);
    chain.put(md.address, md.info);
    if (spec.json !== undefined) routes[uri] = spec.json;
    else routes[uri] = { body: { name: "T", sonata: { feeModel: spec.feeModel } } };
    added.push({ ...m, treasury, uri });
  }
  // One shared quote account: fund it with everything owed.
  const total = markets.reduce((s, x) => s + (x.owed ?? 100_000_000n), 0n);
  chain.put(quoteAta(payer.publicKey), kit.tokenAccount({ owner: payer.publicKey, mint: QUOTE, amount: total }));
  const web = kit.fakeFetch(routes);
  const lines = [];
  const pass = (over = {}) =>
    runPass({ connection: chain.connection, payer, dryRun, spacingMs: 0, confirmPollMs: 0, ledger, fetchImpl: web.fetchImpl, log: (l) => lines.push(l), ...over });
  const counts = await pass();
  return { counts, chain, ledger, lines, added, payer, web, admin, pass };
}

test("a buyback market (from its metadata) swaps on its DBC pool and burns what it bought, in one transaction", async () => {
  const run = await modulePass({ markets: [{ feeModel: "buyback" }] });
  const [m] = run.added;
  const pool = m.pool.toBase58();
  assert.deepEqual(run.ledger.models.get(pool), { feeModel: "buyback", config: null, note: null, uri: m.uri });
  assert.equal(run.web.requests.length, 1);
  assert.equal(run.counts.rewards.txs, 1);
  assert.equal(run.counts.rewards.atoms, 100_000_000n);
  const [row] = run.ledger.payouts;
  assert.equal(row.module, "buyback");
  assert.equal(row.detail.burned, run.chain.delivered[0]);
  assert.equal(run.chain.balance(getAssociatedTokenAddressSync(m.baseMint, run.payer.publicKey, false, TOKEN_PROGRAM_ID)), 0n);
  assert.equal(run.chain.balance(quoteAta(run.payer.publicKey)), 0n);
  assert.ok(run.chain.sent.every((s) => s.bytes <= MAX_TX_BYTES));
  assert.match(run.lines.find((l) => l.startsWith("rewards ")), new RegExp(`^rewards pool=${pool} model=buyback .*action=pay venue=dbc spend=100000000 .*burned=${row.detail.burned} paidNow=100000000 recipients=0 txs=1 left=0`));
  assert.match(run.lines.find((l) => l.startsWith("reward ")), /model=buyback venue=dbc spent=100000000 burned=\d+ bytes=\d+ sig=\S+ result=paid/);
  // The model is cached: the next pass reads no metadata.
  await run.pass();
  assert.equal(run.web.requests.length, 1);
});

test("a dry run of a buyback simulates it (with the swap's delivered amount read back) and sends nothing", async () => {
  const run = await modulePass({ markets: [{ feeModel: "buyback" }], dryRun: true });
  assert.equal(run.counts.rewards.simulated, 1);
  assert.equal(run.chain.sent.length, 0);
  assert.equal(run.ledger.models.size, 0);
  assert.match(run.lines.find((l) => l.startsWith("reward ")), /model=buyback .*result=simulated received=\d+ units=60000/);
});

test("top buyers, split and holders markets are each paid by their own module; unknown models are holders", async () => {
  const [a, b, w1, w2] = [wallet(), wallet(), wallet(), wallet()];
  const now = Math.floor(Date.now() / 1000);
  const trades = [
    { trader: a.toBase58(), side: "buy", quote_amount: "900", base_amount: "9000", block_time: new Date((now - 600) * 1000).toISOString() },
    { trader: b.toBase58(), side: "buy", quote_amount: "500", base_amount: "5000", block_time: new Date((now - 600) * 1000).toISOString() },
  ];
  const split = [{ wallet: w1.toBase58(), weight: 3 }, { wallet: w2.toBase58(), weight: 1 }];
  const ledger = kit.memLedger({ trades });
  const run = await modulePass({
    ledger,
    markets: [
      { feeModel: "topBuyers", owed: 1_000_000n },
      { json: { body: { sonata: { feeModel: "split", split } } }, owed: 1_000_000n },
      { json: { body: { sonata: { feeModel: "burnItAll" } } }, owed: 1_000_000n },
    ],
  });
  const [bounty, splitMarket, unknown] = run.added.map((m) => m.pool.toBase58());
  for (const t of trades) t.pool = bounty;
  // The bounty's trades were attached after the first pass: run it again for the bounty.
  // The winners hold what they bought, and held none at a snapshot from before the round.
  kit.withOwnerLookup(run.chain);
  kit.holdBase(run.chain, run.added[0], a, 9_000n);
  kit.holdBase(run.chain, run.added[0], b, 5_000n);
  await ledger.recordSnapshot(bounty, "holders", now - 5000, []);
  const [ta, tb] = [a, b].map((w) => quoteAta(w));
  run.chain.put(ta, kit.tokenAccount({ owner: a, mint: QUOTE }));
  run.chain.put(tb, kit.tokenAccount({ owner: b, mint: QUOTE }));
  await run.pass();
  assert.equal(run.chain.balance(ta), 500_000n);
  assert.equal(run.chain.balance(tb), 300_000n);
  // The split created both wallets' quote accounts and paid 3:1.
  assert.equal(run.chain.balance(quoteAta(w1)), 750_000n);
  assert.equal(run.chain.balance(quoteAta(w2)), 250_000n);
  assert.equal(ledger.models.get(unknown).feeModel, "holders");
  assert.match(ledger.models.get(unknown).note, /unknown fee model "burnItAll"/);
  const modules = new Map(ledger.payouts.map((r) => [r.pool, r.module]));
  assert.equal(modules.get(bounty), "topBuyers");
  assert.equal(modules.get(splitMarket), "split");
  assert.ok(run.lines.some((l) => l.startsWith(`rewards pool=${unknown} model=holders`)));
});

test("a market whose metadata cannot be read right now waits, its funds owed, and is read again next pass", async () => {
  const run = await modulePass({ markets: [{ json: { status: 503, body: "" }, profile: { sonata: { feeModel: "buyback" } } }] });
  const [m] = run.added;
  const pool = m.pool.toBase58();
  assert.equal(run.ledger.models.size, 0);
  assert.equal(run.counts.rewards.skipped, 1);
  assert.equal(run.chain.sent.length, 0);
  assert.match(run.lines.find((l) => l.startsWith("rewards ")), /action=skip reason="fee model not read \(metadata HTTP 503\); read again next pass, funds stay owed"/);
  // It answers on the next pass: a buyback, not a holders payout.
  const routes = { [m.uri]: { body: { sonata: { feeModel: "buyback" } } } };
  await run.pass({ fetchImpl: kit.fakeFetch(routes).fetchImpl });
  assert.equal(run.ledger.models.get(pool).feeModel, "buyback");
  assert.equal(run.ledger.payouts[0].module, "buyback");
});

// ---- After graduation: claim_graduated ---------------------------------------

test("after graduation the Vault's position fees are claimed when they reach the threshold", () => {
  const plan = planMarket(state({ migrated: true, graduatedFee: 130_335n }));
  assert.deepEqual(plan, { claim: false, claimGraduated: true, distribute: true, createPayout: false, createPlatform: false, reason: null });
  // The DBC claim stays only while the virtual pool still shows partner fees.
  assert.equal(planMarket(state({ migrated: true, partnerQuoteFee: 20_000n, graduatedFee: 20_000n })).claim, true);
  const below = planMarket(state({ migrated: true, graduatedFee: 9_999n }), 10_000n);
  assert.equal(below.claimGraduated, false);
  assert.equal(below.distribute, false);
  assert.match(below.reason, /graduated fee 9999 below 10000/);
  // Zero is a no-op, whatever the threshold.
  assert.equal(planMarket(state({ migrated: true, graduatedFee: 0n }), 0n).claimGraduated, false);
  assert.match(planMarket(state({ graduatedFee: 50_000n, treasuryBaseReady: false })).reason, /cannot claim/);
  const frozen = planMarket(state({ graduatedFee: 50_000n, payoutAccount: "frozen" }));
  assert.equal(frozen.claimGraduated, true);
  assert.equal(frozen.distribute, false);
});

const graduatedMarket = () => {
  const m = splitMarket("standard");
  const k = () => Keypair.generate().publicKey;
  return { ...m, graduated: { dammPool: k(), position: k(), positionNftAccount: k(), tokenAVault: k(), tokenBVault: k() } };
};

test("claim_graduated names the Vault, the treasury, the graduated pool and the Vault's position, as the IDL orders them", async () => {
  const m = graduatedMarket();
  const g = m.graduated;
  const ix = await claimGraduatedIx(m, g);
  assert.ok(ix.programId.equals(program.programId));
  assert.ok(ix.data.equals(disc("claim_graduated")));
  const DAMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
  const expected = [
    [VAULT, false], [m.treasury, true], [DAMM_POOL_AUTHORITY, false], [g.dammPool, false], [g.position, true],
    [m.treasuryBase, true], [m.treasuryQuote, true], [g.tokenAVault, true], [g.tokenBVault, true],
    [m.baseMint, false], [m.quoteMint, false], [g.positionNftAccount, false],
    [TOKEN_PROGRAM_ID, false], [TOKEN_2022_PROGRAM_ID, false], [DAMM_EVENT_AUTHORITY, false], [DAMM, false],
  ];
  assert.deepEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isWritable, k.isSigner]), expected.map(([k, w]) => [k.toBase58(), w, false]));
  assert.ok(DAMM_EVENT_AUTHORITY.equals(PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DAMM)[0]));
  assert.equal(DAMM_POOL_AUTHORITY.toBase58(), "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
  // Its IDL account list is the same, in order.
  assert.deepEqual(treasuryIdl.instructions.find((i) => i.name === "claim_graduated").accounts.map((a) => a.name), [
    "vault", "treasury", "damm_pool_authority", "damm_pool", "position", "treasury_base", "treasury_quote", "token_a_vault", "token_b_vault",
    "base_mint", "quote_mint", "position_nft_account", "token_base_program", "token_quote_program", "damm_event_authority", "damm_program",
  ]);
});

test("claim_graduated, both payout account creations and distribute_split fit one transaction", async () => {
  const payer = Keypair.generate().publicKey;
  const m = graduatedMarket();
  const steps = await buildSteps(m, { claim: false, claimGraduated: true, distribute: true, createPayout: true, createPlatform: true }, payer);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0].map((s) => s.label), ["compute budget", "claim_graduated", "create payout account", "create platform account", "distribute_split"]);
  const bytes = txBytes(steps[0].map((s) => s.ix), payer);
  assert.ok(bytes <= MAX_TX_BYTES, `${bytes} bytes`);
  assert.equal(bytes, 975);
  // With a DBC claim as well (partner fees still shown): at most two transactions, each within the limit.
  const both = await buildSteps(m, { claim: true, claimGraduated: true, distribute: true, createPayout: true, createPlatform: true }, payer);
  for (const step of both) assert.ok(txBytes(step.map((s) => s.ix), payer) <= MAX_TX_BYTES);
  assert.deepEqual(both.flat().map((s) => s.label).filter((l) => l !== "compute budget"), ["claim", "claim_graduated", "create payout account", "create platform account", "distribute_split"]);
  await assert.rejects(buildSteps({ ...m, graduated: null }, { claimGraduated: true, distribute: true }, payer), /graduated position unknown/);
});

test("the Vault's position is found once for every graduated market and then read from the cache", async () => {
  const chain = kit.fakeChain();
  const crank = Keypair.generate().publicKey;
  const markets = [0, 1, 2].map(() => kit.rewardMarket(chain, crank));
  const damm = [];
  for (const [i, m] of markets.entries()) {
    const d = kit.dbcAccounts(m, { migrated: i < 2 });
    chain.put(m.pool, d.poolInfo);
    chain.put(m.config, d.configInfo);
    const pool = kit.dammPoolAccount(m, { migrationFeeOption: d.config.migrationFeeOption });
    chain.put(pool.address, pool.info);
    damm.push(pool);
  }
  const vaultOwned = (pool, permanent) => ({ position: Keypair.generate().publicKey, positionNftAccount: Keypair.generate().publicKey, positionState: { pool, permanentLockedLiquidity: new anchor.BN(String(permanent)) } });
  // The Vault holds the graduation position of the first market only (and, say, a smaller one there too).
  const positions = [vaultOwned(damm[0].address, 5), vaultOwned(damm[0].address, 10n ** 20n), vaultOwned(Keypair.generate().publicKey, 1)];
  let lookups = 0;
  const saved = new Map();
  const ledger = {
    graduatedPositions: async (pools) => new Map(pools.filter((p) => saved.has(p)).map((p) => [p, saved.get(p)])),
    saveGraduatedPosition: async (pool, g) => void saved.set(pool, g),
  };
  const infoOf = (k) => chain.accounts.get(k.toBase58()) ?? null;
  const args = { markets, infoOf, connection: chain.connection, rpc: (fn) => fn(), ledger, positionsOf: async () => (lookups++, positions) };
  const found = await graduatedAccounts(args);
  const [a, b, c] = markets.map((m) => m.pool.toBase58());
  assert.equal(lookups, 1);
  assert.ok(found.get(a).position.equals(positions[1].position));
  // Derived from the config's migration fee option, as readGraduation derives it.
  const option = kit.dbcAccounts(markets[0]).config.migrationFeeOption;
  assert.ok(found.get(a).dammPool.equals(graduatedPool(markets[0], { migrationFeeOption: option })));
  assert.ok(found.get(a).dammPool.equals(damm[0].address));
  assert.ok(found.get(a).tokenAVault.equals(damm[0].state.tokenAVault) && found.get(a).tokenBVault.equals(damm[0].state.tokenBVault));
  assert.match(found.get(b).error, /holds no position/);
  assert.equal(found.has(c), false); // still on its curve
  assert.deepEqual([...saved.keys()], [a]);
  // Next pass: the first market from the cache, only the second looked up again.
  await graduatedAccounts(args);
  assert.equal(lookups, 2);
  assert.equal(vaultPosition(positions, Keypair.generate().publicKey), null);
});

test("a pass over a graduated market simulates claim_graduated, then claims and splits in one transaction", async () => {
  const admin = wallet();
  const run = (graduatedFee, over = {}) => fakeChain({ markets: [{ mode: "standard", fee: 0n, graduated: true }], vaultAdminKey: admin, graduatedFee, ...over });
  const chain = await run(130_335n);
  assert.deepEqual(chain.counts, { markets: 1, sent: 0, simulated: 1, skipped: 0, failed: 0 });
  // The Vault's position lookup (its NFTs, then their positions), then the probe and the transaction's simulation.
  assert.ok(chain.calls.includes("getTokenAccountsByOwner"));
  const [probe, tx] = chain.simulated;
  const treasuryIxs = (ixs) => ixs.filter((ix) => ix.program.equals(program.programId)).map((ix) => ix.data.subarray(0, 8));
  assert.deepEqual(treasuryIxs(probe), [disc("claim_graduated")]);
  assert.deepEqual(treasuryIxs(tx), [disc("claim_graduated"), disc("distribute_split")]);
  const claim = tx.find((ix) => ix.data.subarray(0, 8).equals(disc("claim_graduated")));
  const { damm } = chain.added[0];
  assert.ok(claim.accounts[3].equals(damm.address));
  assert.ok(claim.accounts[4].equals(damm.position.address));
  assert.ok(claim.accounts[11].equals(damm.position.nft.address));
  assert.ok(claim.accounts[7].equals(damm.state.tokenAVault) && claim.accounts[8].equals(damm.state.tokenBVault));
  const line = chain.lines.find((l) => l.startsWith("market "));
  assert.match(line, /migrated=1 graduatedFee=130335 action=claim_graduated\+distribute_split/);
  assert.match(line, /result=simulated/);
  // No DBC claim: the graduated pool shows no partner fees.
  assert.ok(!tx.some((ix) => ix.data.subarray(0, 8).equals(disc("claim"))));

  // Nothing earned yet: the probe only, nothing sent or simulated beyond it.
  const idle = await run(0n);
  assert.equal(idle.counts.skipped, 1);
  assert.equal(idle.simulated.length, 1);
  assert.match(idle.lines.find((l) => l.startsWith("market ")), /graduatedFee=0 action=skip reason="nothing to claim or distribute"/);

  // Sent for real: one transaction for the market.
  const sent = await run(130_335n, { funded: true, dryRun: false });
  assert.equal(sent.counts.sent, 1);
  assert.equal(sent.calls.filter((c) => c === "sendRawTransaction").length, 1);
});

test("a diamond market pays its holders weighted by how long they have held", async () => {
  const [steady, flipper, gifted] = [wallet(), wallet(), wallet()];
  const now = Math.floor(Date.now() / 1000);
  const ledger = kit.memLedger();
  const run = await modulePass({ ledger, markets: [{ feeModel: "diamond", owed: 1_100_000n }] });
  const [m] = run.added;
  const pool = m.pool.toBase58();
  // Earlier passes' holder snapshots (in place of the first pass's empty one):
  // both held for 8 days, and an hour ago the flipper held nothing.
  ledger.snapshots.get(`${pool}|holders`).clear();
  await ledger.recordSnapshot(pool, "holders", now - 8 * 86400, [[steady.toBase58(), 10n ** 12n], [flipper.toBase58(), 10n ** 12n]]);
  await ledger.recordSnapshot(pool, "holders", now - 3600, [[steady.toBase58(), 10n ** 12n]]);
  // Equal balances, each with a quote account; 3x, 1x (sold out an hour ago, bought back) and 1x (never seen before).
  for (const owner of [steady, flipper, gifted]) {
    run.chain.put(Keypair.generate().publicKey, kit.tokenAccount({ owner, mint: m.baseMint, amount: 10n ** 12n, program: TOKEN_PROGRAM_ID }));
    run.chain.put(quoteAta(owner), kit.tokenAccount({ owner, mint: QUOTE }));
  }
  await run.pass();
  assert.deepEqual([steady, flipper, gifted].map((w) => run.chain.balance(quoteAta(w))), [660_000n, 220_000n, 220_000n]);
  const [row] = ledger.payouts;
  assert.equal(row.module, "diamond");
  assert.deepEqual(row.detail.multipliers, { 1: 2, 1.5: 0, 2: 0, 3: 1 });
  assert.match(run.lines.findLast((l) => l.startsWith("rewards ")), /model=diamond .*multipliers=1x:2,1.5x:0,2x:0,3x:1 holders=3 payable=3/);
});

// ---- Time budgets and market order ---------------------------------------------

// Runs fn with Date.now moved forward by what fn's `advance(ms)` adds (a slow RPC, in effect).
async function withClock(fn) {
  const real = Date.now;
  let skew = 0;
  Date.now = () => real() + skew;
  try {
    return await fn((ms) => (skew += ms));
  } finally {
    Date.now = real;
  }
}

test("each pass walks the markets from a different start, so none is always last", () => {
  const pools = (list) => list.map((m) => m.pool.toBase58());
  for (const n of [2, 3, 7, 20, 61]) {
    const list = Array.from({ length: n }, () => ({ pool: Keypair.generate().publicKey }));
    const sorted = pools([...list].sort((a, b) => (a.pool.toBase58() < b.pool.toBase58() ? -1 : 1)));
    // Every order is the pool order started somewhere, whatever order the RPC listed them in.
    for (const pass of [0, 1, 2, 2_111_111]) {
      const order = pools(rotation(list, pass));
      const at = order.indexOf(sorted[0]);
      assert.deepEqual([...order.slice(at), ...order.slice(0, at)], sorted);
      assert.deepEqual(pools(rotation([...list].reverse(), pass)), order);
    }
    // With time for only k markets a pass, every market is among the first k within
    // 2 × ceil(n / k) passes, from any pass on; and from three markets up the last one changes every pass.
    for (const k of [1, 2, Math.ceil(n / 3)]) {
      for (let from = 2_111_000; from < 2_111_040; from++) {
        const reached = new Set();
        for (let pass = from; pass < from + 2 * Math.ceil(n / k); pass++) pools(rotation(list, pass)).slice(0, k).forEach((p) => reached.add(p));
        assert.equal(reached.size, n, `n=${n} k=${k} from=${from}`);
        if (n >= 3) assert.notEqual(pools(rotation(list, from)).at(-1), pools(rotation(list, from + 1)).at(-1));
      }
    }
  }
  assert.deepEqual(PHASE_ENDS_MS, { claims: 180_000, rewards: 360_000, airdrops: 480_000 });
});

test("the claim phase stops at its slot, and the reward payouts still get theirs", async () => {
  const ledger = memLedger();
  await withClock(async (advance) => {
    const chain = await fakeChain({
      funded: true, dryRun: false, ledger, vaultAdminKey: wallet(),
      markets: [
        ...Array.from({ length: 4 }, () => ({ mode: "refrain" })),
        { mode: "standard", reward: true, fee: 0n, distributed: 1_000_000n, payoutBalance: 1_000_000n, holders: [{ owner: wallet(), amount: 400_000_000n, quote: true }] },
      ],
      // Each claim takes 2.5 minutes: two fit in the claim phase's 3.
      onLog: (l) => l.startsWith("market ") && l.includes("result=sent") && advance(150_000),
    });
    assert.equal(chain.counts.sent, 2);
    assert.equal(chain.lines.filter((l) => /mode=refrain action=skip reason="claim phase time budget used; next pass"/.test(l)).length, 2);
    // Five minutes in: the reward phase (until 6) still pays.
    assert.equal(chain.counts.rewards.txs, 1);
    assert.equal(ledger.payouts.length, 1);
    assert.match(chain.lines.at(-1), /^summary .*sent=2 .*rewardTxs=1/);
  });
});

test("reward payouts stop starting transactions at the end of their slot, leaving the airdrops theirs", async () => {
  const ledger = memLedger();
  const holders = Array.from({ length: 45 }, () => ({ owner: wallet(), amount: 10_000_000n, quote: true }));
  await withClock(async (advance) => {
    const chain = await fakeChain({
      funded: true, dryRun: false, ledger, vaultAdminKey: wallet(),
      markets: [{ mode: "standard", reward: true, fee: 0n, distributed: 1_000_000n, payoutBalance: 1_000_000n, holders }],
      // Each payout transaction takes 3.5 minutes: the third would start at 7, past the phase's 6.
      onLog: (l) => l.startsWith("reward ") && l.includes("result=paid") && advance(210_000),
    });
    assert.deepEqual(ledger.payouts.map((r) => r.recipients), [20, 20]);
    assert.match(chain.lines.find((l) => l.startsWith("rewards ")), /txs=2 left=111120 .*note="pass time budget used; the rest stays owed"/);
  });
});

test("a phase that fails as a whole is logged and counted, and the pass still ends with its summary", async () => {
  const payer = Keypair.generate();
  // An airdrop market (the crank key is its leftover receiver), and a ledger that cannot even say whether it is ready.
  const ledger = { ...kit.memLedger(), ready: () => { throw Error("ledger connection lost"); } };
  const chain = await fakeChain({ payer, ledger, vaultAdminKey: wallet(), markets: [{ mode: "refrain", leftoverReceiver: payer.publicKey }] });
  assert.equal(chain.counts.simulated, 1);
  assert.deepEqual(chain.counts.airdrops, { markets: 1, txs: 0, atoms: 0n, failed: 1 });
  assert.ok(chain.lines.includes('airdrop action=fail markets=1 reason="ledger connection lost"'));
  assert.match(chain.lines.at(-1), /^summary .*airdropFailed=1/);
});

test("one graduated market's unusable config does not stop the others' claim_graduated lookup", async () => {
  const chain = kit.fakeChain();
  const crank = Keypair.generate().publicKey;
  const markets = [0, 1].map(() => kit.rewardMarket(chain, crank));
  const damm = [];
  for (const [i, m] of markets.entries()) {
    // The second names a migration fee option DBC does not have.
    const d = kit.dbcAccounts(m, { migrated: true, edit: i ? ({ config }) => (config.migrationFeeOption = 99) : undefined });
    chain.put(m.pool, d.poolInfo);
    chain.put(m.config, d.configInfo);
    if (!i) {
      const pool = kit.dammPoolAccount(m, { migrationFeeOption: d.config.migrationFeeOption });
      chain.put(pool.address, pool.info);
      damm.push(pool);
    }
  }
  const position = { position: Keypair.generate().publicKey, positionNftAccount: Keypair.generate().publicKey, positionState: { pool: damm[0].address, permanentLockedLiquidity: new anchor.BN(1) } };
  const found = await graduatedAccounts({
    markets, infoOf: (k) => chain.accounts.get(k.toBase58()) ?? null, connection: chain.connection, rpc: (fn) => fn(), ledger: null, positionsOf: async () => [position],
  });
  assert.ok(found.get(markets[0].pool.toBase58()).position.equals(position.position));
  assert.match(found.get(markets[1].pool.toBase58()).error, /unsupported migration fee option/);
});
