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
  destinationState,
  modeOf,
  planMarket,
  runPass,
  txBytes,
  vaultAdmin,
  DEVNET_GENESIS,
  MAX_TX_BYTES,
  SPLIT_MODES,
} from "./crank.mjs";

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
  assert.deepEqual(plan, { claim: false, distribute: false, createPayout: false, createPlatform: false, reason: "nothing to claim or distribute" });
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
  assert.deepEqual(plan, { claim: false, distribute: true, createPayout: false, createPlatform: false, reason: null });
});

test("claim and distribute together once fees reach the threshold", () => {
  for (const unallocated of [0n, 250n]) {
    const plan = planMarket(state({ partnerQuoteFee: 240_000n, unallocated }));
    assert.deepEqual(plan, { claim: true, distribute: true, createPayout: false, createPlatform: false, reason: null });
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
  const steps = await buildSteps(m, { claim: true, distribute: true, createPayout: true }, payer);
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
  assert.deepEqual(missing, { claim: false, distribute: true, createPayout: false, createPlatform: true, reason: null });
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
    const steps = await buildSteps(m, { claim: true, distribute: true, createPayout: true, createPlatform: true }, payer);
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
  const steps = await buildSteps(m, { claim: false, distribute: true, createPayout: true, createPlatform: true }, admin);
  assert.deepEqual(steps[0].map((s) => s.label), ["compute budget", "create payout account", "distribute_split"]);
});

test("a platform-mode split is never built without the Vault admin's account", async () => {
  const m = market({ mode: "standardFloor" });
  await assert.rejects(buildSteps(m, { claim: false, distribute: true }, Keypair.generate().publicKey), /platform account unknown/);
  // A claim alone does not need it.
  const steps = await buildSteps(m, { claim: true, distribute: false }, Keypair.generate().publicKey);
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
  supply = 2_000_000_000n, holders = [], vaultHolding = 0n, treasuryHolding = 0n,
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
  }));
  put(config, dbcAccount("poolConfig", (c) => Object.assign(c, { feeClaimer: VAULT, quoteMint: QUOTE })));
  put(baseMint, baseMintAccount(supply));
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
  return { pool, treasury, payoutOwner, baseMint, tokens };
}
// The reward ledger in memory, as indexer/rewards.mjs pgLedger behaves.
function memLedger() {
  const payouts = [], pending = new Map();
  return {
    payouts,
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
  };
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
async function fakeChain({ markets, vaultAdminKey, payer = Keypair.generate(), funded = false, dryRun = true, ledger = null, poison = new Set(), rewardMinAtoms }) {
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
    simulateTransaction: async (tx) => {
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
      return { value: { err: null, logs: [], unitsConsumed: 60_000 } };
    },
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
    runPass({ connection, payer, dryRun, spacingMs: 0, confirmPollMs: 0, ledger, rewardMinAtoms, log: (l) => lines.push(l), ...over });
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
  const [split, legacy] = chain.simulated;
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
  assert.deepEqual(chain.counts.rewards, { markets: 1, txs: 1, atoms: 777_777n, recipients: 2, simulated: 0, skipped: 0, failed: 0 });
  // owed 1000000 over 4:3:2 of the eligible 900000000: h3 (222222) has no quote account.
  const [tx] = rewardTxs(chain);
  assert.deepEqual(transfersOf(tx.tx), [[quoteAta(h1).toBase58(), 444_444n], [quoteAta(h2).toBase58(), 333_333n]]);
  assert.ok(tx.tx.feePayer.equals(payer.publicKey));
  for (const ix of tx.tx.instructions) {
    assert.ok(ix.keys[0].pubkey.equals(quoteAta(payer.publicKey)));
    assert.ok(ix.keys[3].pubkey.equals(payer.publicKey) && ix.keys[3].isSigner);
  }
  assert.equal(balanceOf(chain, payer.publicKey), 222_223n);
  assert.deepEqual(ledger.payouts.map(({ pool: p, amount, recipients, signature }) => ({ p, amount, recipients, signature })), [
    { p: pool, amount: 777_777n, recipients: 2, signature: tx.signature },
  ]);
  assert.equal(ledger.pendingRows.size, 0);
  const paid = chain.lines.find((l) => l.startsWith("reward "));
  assert.match(paid, new RegExp(`^reward pool=${pool} sig=${tx.signature} amount=777777 recipients=2 bytes=\\d+ result=paid$`));
  assert.match(chain.lines.find((l) => l.startsWith("rewards ")), /action=pay holders=3 payable=2 noAta=1 paidNow=777777 recipients=2 txs=1 left=222223/);
  assert.match(chain.lines.at(-1), /^summary .*rewardMarkets=1 rewardTxs=1 rewardAtoms=777777 rewardFailed=0/);
});

test("later passes pay only what is still owed, and nothing below REWARD_MIN_ATOMS", async () => {
  const payer = Keypair.generate(), ledger = memLedger();
  const [h1, h2] = [wallet(), wallet()];
  const chain = await fakeChain({
    payer, funded: true, dryRun: false, ledger, vaultAdminKey: wallet(),
    markets: [{
      mode: "standard", reward: true, fee: 0n, distributed: 1_000_000n, payoutBalance: 1_000_000n,
      holders: [
        { owner: h1, amount: 400_000_000n, quote: true },
        { owner: h2, amount: 300_000_000n, quote: true },
        { owner: wallet(), amount: 200_000_000n, quote: false },
      ],
    }],
  });
  const total = () => ledger.payouts.reduce((s, r) => s + r.amount, 0n);
  assert.equal(total(), 777_777n);
  // Second pass: 222223 still owed (the holder without a quote account keeps its share owed).
  const second = await chain.pass();
  assert.equal(second.rewards.atoms, 98_765n + 74_074n);
  assert.equal(total(), 950_616n);
  // Third pass: 49384 owed, below the 100000 default.
  const third = await chain.pass();
  assert.deepEqual({ ...third.rewards, markets: undefined }, { markets: undefined, txs: 0, atoms: 0n, recipients: 0, simulated: 0, skipped: 1, failed: 0 });
  assert.match(chain.lines.findLast((l) => l.startsWith("rewards ")), /owed=49384 action=skip reason="owed below 100000"/);
  // A lower threshold pays it; never more than the treasury distributed.
  await chain.pass({ rewardMinAtoms: 10_000n });
  assert.ok(total() <= 1_000_000n);
  assert.equal(balanceOf(chain, payer.publicKey), 1_000_000n - total());
  assert.equal(balanceOf(chain, h1) + balanceOf(chain, h2), total());
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
