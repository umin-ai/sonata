import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
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
async function addMarket(accounts, rows, { mode, fee = 20_000n, payoutExists = true, platformOwner, platformExists = false }) {
  const pool = Keypair.generate().publicKey,
    config = Keypair.generate().publicKey,
    baseMint = Keypair.generate().publicKey,
    creator = Keypair.generate().publicKey,
    payoutOwner = Keypair.generate().publicKey;
  const [treasury] = PublicKey.findProgramAddressSync([Buffer.from("treasury"), pool.toBuffer()], program.programId);
  const zero = new anchor.BN(0);
  const data = await program.coder.accounts.encode("treasury", {
    pool, config, quoteMint: QUOTE, baseMint, creator, payoutOwner, mode: { [mode]: {} }, bump: 255,
    totalClaimed: zero, totalDistributed: zero, totalRetained: zero, totalWithdrawn: zero, lastClaimTs: zero,
  });
  rows.push({ pubkey: treasury, account: { data, owner: program.programId, lamports: 1, executable: false } });
  const put = (k, v) => accounts.set(k.toBase58(), v);
  put(pool, dbcAccount("virtualPool", (p) => {
    Object.assign(p, { config, baseMint, creator, baseVault: Keypair.generate().publicKey, quoteVault: Keypair.generate().publicKey, partnerQuoteFee: new anchor.BN(String(fee)) });
  }));
  put(config, dbcAccount("poolConfig", (c) => Object.assign(c, { feeClaimer: VAULT, quoteMint: QUOTE })));
  put(getAssociatedTokenAddressSync(baseMint, treasury, true, TOKEN_PROGRAM_ID), tokenAccount(treasury, baseMint, AccountState.Initialized, 0n, TOKEN_PROGRAM_ID));
  put(getAssociatedTokenAddressSync(QUOTE, treasury, true, TOKEN_2022_PROGRAM_ID), tokenAccount(treasury, QUOTE));
  if (payoutExists) put(getAssociatedTokenAddressSync(QUOTE, payoutOwner, true, TOKEN_2022_PROGRAM_ID), tokenAccount(payoutOwner, QUOTE));
  if (platformExists) put(getAssociatedTokenAddressSync(QUOTE, platformOwner, true, TOKEN_2022_PROGRAM_ID), tokenAccount(platformOwner, QUOTE));
  return { pool, treasury, payoutOwner };
}
async function fakeChain({ markets, vaultAdminKey }) {
  const accounts = new Map([[QUOTE.toBase58(), quoteMintAccount()]]);
  if (vaultAdminKey)
    accounts.set(VAULT.toBase58(), {
      data: await program.coder.accounts.encode("vault", { admin: vaultAdminKey, bump: 255, treasuries: new anchor.BN(markets.length) }),
      owner: program.programId,
      lamports: 1,
      executable: false,
    });
  const rows = [];
  const added = [];
  for (const m of markets) added.push(await addMarket(accounts, rows, { platformOwner: vaultAdminKey, ...m }));
  const calls = [];
  const simulated = [];
  const connection = {
    getGenesisHash: async () => (calls.push("getGenesisHash"), DEVNET_GENESIS),
    getProgramAccounts: async () => (calls.push("getProgramAccounts"), rows),
    getAccountInfo: async (k) => (calls.push(`getAccountInfo ${k.toBase58()}`), accounts.get(k.toBase58()) ?? null),
    getMultipleAccountsInfo: async (keys) => (calls.push("getMultipleAccountsInfo"), keys.map((k) => accounts.get(k.toBase58()) ?? null)),
    simulateTransaction: async (tx) => {
      calls.push("simulateTransaction");
      const keys = tx.message.staticAccountKeys;
      simulated.push(tx.message.compiledInstructions.map((ix) => ({
        program: keys[ix.programIdIndex],
        accounts: ix.accountKeyIndexes.map((i) => keys[i]),
        data: Buffer.from(ix.data),
      })));
      return { value: { err: null, logs: [], unitsConsumed: 60_000 } };
    },
  };
  const lines = [];
  const counts = await runPass({ connection, payer: Keypair.generate(), dryRun: true, spacingMs: 0, log: (l) => lines.push(l) });
  return { counts, calls, simulated, lines, added };
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
