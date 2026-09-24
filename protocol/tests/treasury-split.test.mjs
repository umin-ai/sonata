// SPDX-License-Identifier: GPL-3.0-or-later
// Sonata platform share. Of what the treasury claims (80% of the trading fee;
// Meteora keeps 20%), Standard pays 50% to the creator and 50% to Sonata, and
// StandardFloor pays 25% to the creator, retains 25% as a Stock Floor and pays
// 50% to Sonata. On $1,000 traded at a 1.25% fee the treasury claims $10:
// creator $5 / Sonata $5, or creator $2.50 / floor $2.50 / Sonata $5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { getTransactionDecoder } from "@solana/kit";
import {
  Keypair,
  PublicKey,
  Connection,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
const idl = JSON.parse(readFileSync("target/idl/stockroom_treasury.json")),
  id = new PublicKey(idl.address),
  bn = (n) => new anchor.BN(String(n));
const [VAULT, VAULT_BUMP] = PublicKey.findProgramAddressSync(
  [Buffer.from("stockroom")],
  id,
);

// Quote: `claimed` units claimed and in custody, nothing allocated. Base: 1000
// units of supply, 600 with the holder and 400 standing in for the curve. The
// Vault names `admin` (Sonata) as its admin.
async function fixture({ mode = "standard", claimed = 1000n, payoutIsAdmin = false } = {}) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(id.toBase58(), "target/deploy/stockroom_treasury.so");
  const creator = Keypair.generate(),
    recipient = Keypair.generate(),
    admin = Keypair.generate(),
    holder = Keypair.generate(),
    attacker = Keypair.generate(),
    curve = Keypair.generate(),
    quote = Keypair.generate(),
    base = Keypair.generate(),
    pool = Keypair.generate().publicKey;
  const payoutOwner = payoutIsAdmin ? admin.publicKey : recipient.publicKey;
  for (const k of [creator, recipient, admin, holder, attacker, curve])
    svm.airdrop(k.publicKey.toBase58(), 10_000_000_000n);
  const program = new anchor.Program(
    idl,
    new anchor.AnchorProvider(
      new Connection("http://127.0.0.1:8899"),
      new anchor.Wallet(creator),
      {},
    ),
  );
  const [treasury, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), pool.toBuffer()],
    id,
  );
  const ata = (mint, owner) =>
    getAssociatedTokenAddressSync(mint.publicKey, owner, true);
  async function send(ixs, signer = creator, error) {
    svm.expireBlockhash();
    const tx = new Transaction({
      feePayer: signer.publicKey,
      recentBlockhash: svm.latestBlockhash(),
    }).add(...(await Promise.all(Array.isArray(ixs) ? ixs : [ixs])));
    const extra = [quote, base].filter((m) =>
      tx.instructions.some((i) =>
        i.keys.some((k) => k.isSigner && k.pubkey.equals(m.publicKey)),
      ),
    );
    tx.sign(signer, ...extra);
    const result = svm.sendTransaction(
      getTransactionDecoder().decode(tx.serialize()),
    );
    if (error) {
      assert(result instanceof FailedTransactionMetadata, "expected failure");
      assert.match(result.meta().logs().join("\n"), error);
      return null;
    }
    if (result instanceof FailedTransactionMetadata)
      throw Error(result.meta().logs().join("\n"));
    return result.logs();
  }
  const put = (address, data) =>
    svm.setAccount({
      address: address.toBase58(),
      programAddress: id.toBase58(),
      lamports: 10_000_000n,
      executable: false,
      data,
      space: BigInt(data.length),
    });
  const owners = [
    treasury,
    recipient.publicKey,
    creator.publicKey,
    admin.publicKey,
    holder.publicKey,
    attacker.publicKey,
    curve.publicKey,
  ];
  for (const [mint, decimals] of [
    [quote, 8],
    [base, 6],
  ])
    await send([
      SystemProgram.createAccount({
        fromPubkey: creator.publicKey,
        newAccountPubkey: mint.publicKey,
        space: MINT_SIZE,
        lamports: 2_000_000,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        mint.publicKey,
        decimals,
        creator.publicKey,
        null,
      ),
      ...owners.map((o) =>
        createAssociatedTokenAccountIdempotentInstruction(
          creator.publicKey,
          ata(mint, o),
          o,
          mint.publicKey,
        ),
      ),
    ]);
  const mintTo = (mint, owner, amount, decimals) =>
    createMintToCheckedInstruction(
      mint.publicKey,
      ata(mint, owner),
      creator.publicKey,
      amount,
      decimals,
    );
  await send([
    mintTo(quote, treasury, claimed, 8),
    mintTo(base, holder.publicKey, 600n, 6),
    mintTo(base, curve.publicKey, 400n, 6),
  ]);
  put(
    VAULT,
    await program.coder.accounts.encode("vault", {
      admin: admin.publicKey,
      bump: VAULT_BUMP,
      treasuries: bn(1),
    }),
  );
  put(
    treasury,
    await program.coder.accounts.encode("treasury", {
      pool,
      config: Keypair.generate().publicKey,
      quoteMint: quote.publicKey,
      baseMint: base.publicKey,
      creator: creator.publicKey,
      payoutOwner,
      mode: { [mode]: {} },
      bump,
      totalClaimed: bn(claimed),
      totalDistributed: bn(0),
      totalRetained: bn(0),
      totalWithdrawn: bn(0),
      lastClaimTs: bn(0),
    }),
  );
  const treasuryQuote = ata(quote, treasury),
    payoutQuote = ata(quote, payoutOwner),
    platformQuote = ata(quote, admin.publicKey);
  const split = (over = {}) =>
    program.methods
      .distributeSplit()
      .accountsStrict({
        vault: VAULT,
        treasury,
        treasuryQuote,
        payoutQuote,
        platformQuote,
        quoteMint: quote.publicKey,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        ...over,
      })
      .instruction();
  const distribute = () =>
    program.methods
      .distribute()
      .accounts({
        treasury,
        treasuryQuote,
        payoutQuote,
        quoteMint: quote.publicKey,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  const withdraw = (amount) =>
    program.methods
      .withdrawRetained(bn(amount))
      .accounts({
        treasury,
        creator: creator.publicKey,
        treasuryQuote,
        creatorQuote: ata(quote, creator.publicKey),
        quoteMint: quote.publicKey,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  const redeem = (amount, signer = holder) =>
    program.methods
      .redeem(bn(amount))
      .accounts({
        treasury,
        holder: signer.publicKey,
        holderBase: ata(base, signer.publicKey),
        holderQuote: ata(quote, signer.publicKey),
        treasuryQuote,
        baseMint: base.publicKey,
        quoteMint: quote.publicKey,
        tokenBaseProgram: TOKEN_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  const data64 = (a, offset) =>
    Buffer.from(svm.getAccount(a.toBase58()).data).readBigUInt64LE(offset);
  const balance = (mint, owner) => data64(ata(mint, owner), 64);
  const supply = () => data64(base.publicKey, 36);
  const ledger = () => {
    const t = program.coder.accounts.decode(
      "treasury",
      Buffer.from(svm.getAccount(treasury.toBase58()).data),
    );
    const [claimed, distributed, retained, withdrawn] = [
      t.totalClaimed,
      t.totalDistributed,
      t.totalRetained,
      t.totalWithdrawn,
    ].map((v) => BigInt(v.toString()));
    return { t, claimed, distributed, retained, withdrawn };
  };
  // The app's reconcile check (crank.mjs inspect, runtime.ts readTreasury).
  const reconcile = () => {
    const l = ledger();
    const unallocated = l.claimed - l.distributed - l.retained,
      available = l.retained - l.withdrawn;
    assert.ok(unallocated >= 0n && available >= 0n);
    assert.ok(balance(quote, treasury) >= unallocated + available);
    return { unallocated, floor: available };
  };
  // More fees claimed: custody and totalClaimed grow together, as `claim` does.
  const addFees = async (amount) => {
    await send(mintTo(quote, treasury, amount, 8));
    const { t } = ledger();
    put(
      treasury,
      await program.coder.accounts.encode("treasury", {
        ...t,
        totalClaimed: t.totalClaimed.add(bn(amount)),
      }),
    );
  };
  const events = (logs) =>
    logs
      .filter((l) => l.startsWith("Program data: "))
      .map((l) => program.coder.events.decode(l.slice("Program data: ".length)))
      .filter(Boolean);
  return {
    svm,
    program,
    send,
    put,
    split,
    distribute,
    withdraw,
    redeem,
    balance,
    supply,
    ledger,
    reconcile,
    addFees,
    events,
    ata,
    quote,
    base,
    treasury,
    pool,
    creator,
    recipient,
    admin,
    holder,
    attacker,
    curve,
    payoutOwner,
  };
}

for (const [mode, claimed, creator, floor, platform] of [
  ["standard", 1000n, 500n, 0n, 500n],
  ["standard", 1001n, 500n, 0n, 501n],
  ["standard", 3n, 1n, 0n, 2n],
  ["standard", 1n, 0n, 0n, 1n],
  ["standardFloor", 1000n, 250n, 250n, 500n],
  ["standardFloor", 1001n, 250n, 250n, 501n],
  ["standardFloor", 3n, 0n, 0n, 3n],
])
  test(`${mode} splits ${claimed} into creator ${creator} / floor ${floor} / platform ${platform}`, async () => {
    const f = await fixture({ mode, claimed });
    // Permissionless: anyone can crank it; every destination is pinned.
    const logs = await f.send(f.split(), f.attacker);
    assert.equal(f.balance(f.quote, f.recipient.publicKey), creator);
    assert.equal(f.balance(f.quote, f.admin.publicKey), platform);
    assert.equal(f.balance(f.quote, f.treasury), floor);
    assert.equal(f.balance(f.quote, f.attacker.publicKey), 0n);
    const l = f.ledger();
    assert.equal(l.distributed, creator);
    assert.equal(l.retained, floor + platform);
    assert.equal(l.withdrawn, platform);
    assert.deepEqual(f.reconcile(), { unallocated: 0n, floor });
    const [event] = f.events(logs);
    assert.equal(event.name, "splitDistributed");
    assert.ok(event.data.pool.equals(f.pool));
    assert.deepEqual(
      [event.data.creator, event.data.floor, event.data.platform].map((v) => BigInt(v.toString())),
      [creator, floor, platform],
    );
  });

test("the platform share goes only to a token account owned by the Vault admin", async () => {
  const f = await fixture({ mode: "standardFloor" });
  for (const owner of [f.attacker, f.recipient, f.creator])
    await f.send(
      f.split({ platformQuote: f.ata(f.quote, owner.publicKey) }),
      f.attacker,
      /InvalidPlatformRecipient/,
    );
  // The treasury's own custody cannot stand in for the platform account.
  await f.send(
    f.split({ platformQuote: f.ata(f.quote, f.treasury) }),
    f.attacker,
    /InvalidPlatformRecipient/,
  );
  // A lookalike Vault naming the attacker as admin fails the seed check.
  const fake = Keypair.generate().publicKey;
  f.put(
    fake,
    await f.program.coder.accounts.encode("vault", {
      admin: f.attacker.publicKey,
      bump: VAULT_BUMP,
      treasuries: bn(1),
    }),
  );
  await f.send(
    f.split({ vault: fake, platformQuote: f.ata(f.quote, f.attacker.publicKey) }),
    f.attacker,
    /ConstraintSeeds/,
  );
  assert.equal(f.balance(f.quote, f.treasury), 1000n);
  assert.equal(f.balance(f.quote, f.attacker.publicKey), 0n);
  assert.equal(f.reconcile().unallocated, 1000n);
});

test("the creator share goes only to the payout owner's token account", async () => {
  const f = await fixture({ mode: "standard" });
  for (const owner of [f.attacker, f.admin, f.creator])
    await f.send(
      f.split({ payoutQuote: f.ata(f.quote, owner.publicKey) }),
      f.attacker,
      /InvalidRecipient/,
    );
  assert.equal(f.balance(f.quote, f.treasury), 1000n);
  assert.equal(f.balance(f.quote, f.admin.publicKey), 0n);
});

test("a payout owner that is also the Vault admin receives both shares in one account", async () => {
  for (const [mode, paid, floor] of [
    ["standard", 1000n, 0n],
    ["standardFloor", 750n, 250n],
  ]) {
    const f = await fixture({ mode, payoutIsAdmin: true });
    await f.send(f.split(), f.attacker);
    assert.equal(f.balance(f.quote, f.admin.publicKey), paid);
    assert.equal(f.balance(f.quote, f.treasury), floor);
    assert.deepEqual(f.reconcile(), { unallocated: 0n, floor });
  }
});

test("distribute refuses the platform modes", async () => {
  for (const mode of ["standard", "standardFloor"]) {
    const f = await fixture({ mode });
    await f.send(f.distribute(), f.attacker, /UseDistributeSplit/);
    assert.equal(f.balance(f.quote, f.treasury), 1000n);
    assert.equal(f.balance(f.quote, f.recipient.publicKey), 0n);
  }
});

test("distribute_split refuses the modes without a platform share", async () => {
  for (const mode of ["refrain", "duet", "sustain", "floor"]) {
    const f = await fixture({ mode });
    await f.send(f.split(), f.attacker, /UseDistribute\b/);
    assert.equal(f.balance(f.quote, f.treasury), 1000n);
    assert.equal(f.balance(f.quote, f.admin.publicKey), 0n);
    // Their own distribute is unaffected.
    await f.send(f.distribute(), f.attacker);
  }
});

test("the creator cannot withdraw retained stock in either platform mode", async () => {
  for (const [mode, error] of [
    ["standard", /NoCreatorReserve/],
    ["standardFloor", /FloorLocked/],
  ]) {
    const f = await fixture({ mode });
    await f.send(f.withdraw(1), f.creator, error);
    await f.send(f.split());
    await f.send(f.withdraw(1), f.creator, error);
    assert.equal(f.balance(f.quote, f.creator.publicKey), 0n);
    assert.equal(f.balance(f.quote, f.treasury), mode === "standard" ? 0n : 250n);
  }
});

test("a second split with nothing unallocated is refused", async () => {
  for (const mode of ["standard", "standardFloor"]) {
    const f = await fixture({ mode });
    await f.send(f.split());
    await f.send(f.split(), f.attacker, /NothingToDistribute/);
    assert.equal(f.balance(f.quote, f.admin.publicKey), 500n);
  }
});

test("holders redeem the StandardFloor floor for floor × amount ÷ supply, and never reach the other shares", async () => {
  const f = await fixture({ mode: "standardFloor" });
  // Nothing is redeemable before a split retains a floor.
  await f.send(f.redeem(600), f.holder, /NothingToRedeem/);
  await f.send(f.split());
  // 250 floor × 250 burned ÷ 1000 supply = 62.5, paid as 62.
  await f.send(f.redeem(250), f.holder);
  assert.equal(f.balance(f.quote, f.holder.publicKey), 62n);
  assert.equal(f.balance(f.base, f.holder.publicKey), 350n);
  assert.equal(f.supply(), 750n);
  assert.equal(f.balance(f.quote, f.treasury), 188n);
  let l = f.ledger();
  assert.equal(l.withdrawn, 500n + 62n);
  // The floor balance is the floor share less what holders redeemed.
  assert.equal(l.retained - l.withdrawn, 250n - 62n);
  assert.deepEqual(f.reconcile(), { unallocated: 0n, floor: 188n });
  // 188 × 350 ÷ 750 = 87.7, paid as 87; then 101 × 400 ÷ 400 = 101.
  await f.send(f.redeem(350), f.holder);
  await f.send(f.redeem(400, f.curve), f.curve);
  assert.equal(f.balance(f.quote, f.holder.publicKey), 62n + 87n);
  assert.equal(f.balance(f.quote, f.curve.publicKey), 101n);
  // Everyone redeeming everything pays out exactly the floor share.
  assert.equal(62n + 87n + 101n, 250n);
  assert.equal(f.balance(f.quote, f.treasury), 0n);
  assert.equal(f.balance(f.quote, f.recipient.publicKey), 250n);
  assert.equal(f.balance(f.quote, f.admin.publicKey), 500n);
  l = f.ledger();
  assert.equal(l.retained - l.withdrawn, 0n);
});

test("Standard keeps no floor to redeem", async () => {
  const f = await fixture({ mode: "standard" });
  await f.send(f.split());
  await f.send(f.redeem(250), f.holder, /NotFloor/);
});

test("the floor stays retained minus withdrawn across splits and redemptions", async () => {
  const f = await fixture({ mode: "standardFloor" });
  await f.send(f.split());
  await f.send(f.redeem(250), f.holder); // 62 of the 250 floor
  await f.addFees(1001n);
  assert.equal(f.reconcile().unallocated, 1001n);
  const logs = await f.send(f.split(), f.attacker);
  const [event] = f.events(logs);
  assert.deepEqual(
    [event.data.creator, event.data.floor, event.data.platform].map((v) => BigInt(v.toString())),
    [250n, 250n, 501n],
  );
  const l = f.ledger();
  assert.equal(l.claimed, 2001n);
  assert.equal(l.distributed, 250n + 250n);
  assert.equal(l.retained, 250n + 500n + 250n + 501n);
  assert.equal(l.withdrawn, 500n + 62n + 501n);
  // Floor = both floor shares less the redemption, and custody holds exactly it.
  assert.deepEqual(f.reconcile(), { unallocated: 0n, floor: 250n - 62n + 250n });
  assert.equal(f.balance(f.quote, f.treasury), 438n);
  assert.equal(f.balance(f.quote, f.recipient.publicKey), 500n);
  assert.equal(f.balance(f.quote, f.admin.publicKey), 1001n);
  // 438 × 350 ÷ 750 = 204.4, paid as 204.
  await f.send(f.redeem(350), f.holder);
  assert.equal(f.balance(f.quote, f.holder.publicKey), 62n + 204n);
  assert.deepEqual(f.reconcile(), { unallocated: 0n, floor: 438n - 204n });
});

test("init_treasury registers the platform modes with the unchanged account layout", async () => {
  const { createDbcProgram } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const dbcFixture = JSON.parse(readFileSync("tests/fixtures/treasury-dbc.json"));
  for (const [mode, index] of [
    ["standard", 4],
    ["standardFloor", 5],
  ]) {
    const svm = new LiteSVM();
    svm.addProgramFromFile(id.toBase58(), "target/deploy/stockroom_treasury.so");
    const creator = Keypair.generate();
    svm.airdrop(creator.publicKey.toBase58(), 10_000_000_000n);
    const conn = new Connection("http://127.0.0.1:8899"),
      program = new anchor.Program(
        idl,
        new anchor.AnchorProvider(conn, new anchor.Wallet(creator), {}),
      ),
      dbc = createDbcProgram(conn).program;
    const pool = new PublicKey(dbcFixture.pool.address),
      config = new PublicKey(dbcFixture.config.address),
      [treasury] = PublicKey.findProgramAddressSync(
        [Buffer.from("treasury"), pool.toBuffer()],
        id,
      );
    const encode = (name, value) => {
      const info = dbc.coder.accounts.accountLayouts.get(name),
        buffer = Buffer.alloc(4096),
        size = info.layout.encode(value, buffer);
      return Buffer.concat([Buffer.from(info.discriminator), buffer.subarray(0, size)]);
    };
    const decodedPool = dbc.coder.accounts.decode(
      "virtualPool",
      Buffer.from(dbcFixture.pool.data, "base64"),
    );
    (decodedPool.poolState ?? decodedPool).creator = creator.publicKey;
    const decodedConfig = dbc.coder.accounts.decode(
      "poolConfig",
      Buffer.from(dbcFixture.config.data, "base64"),
    );
    decodedConfig.feeClaimer = VAULT;
    const put = (row, data) =>
      svm.setAccount({
        address: row.address,
        programAddress: row.owner,
        lamports: BigInt(row.lamports),
        executable: false,
        data,
        space: BigInt(data.length),
      });
    for (const n of ["quoteMint", "baseMint"])
      put(dbcFixture[n], Buffer.from(dbcFixture[n].data, "base64"));
    put(dbcFixture.pool, encode("virtualPool", decodedPool));
    put(dbcFixture.config, encode("poolConfig", decodedConfig));
    svm.expireBlockhash();
    const tx = new Transaction({
      feePayer: creator.publicKey,
      recentBlockhash: svm.latestBlockhash(),
    }).add(
      await program.methods
        .initVault()
        .accounts({ vault: VAULT, admin: creator.publicKey, systemProgram: SystemProgram.programId })
        .instruction(),
      await program.methods
        .initTreasury({ [mode]: {} }, creator.publicKey)
        .accounts({
          vault: VAULT,
          treasury,
          pool,
          config,
          quoteMint: new PublicKey(dbcFixture.quoteMint.address),
          baseMint: new PublicKey(dbcFixture.baseMint.address),
          creator: creator.publicKey,
          payer: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    );
    tx.sign(creator);
    const res = svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
    if (res instanceof FailedTransactionMetadata) throw Error(res.meta().logs().join("\n"));
    const data = Buffer.from(svm.getAccount(treasury.toBase58()).data);
    // 8 + 6 pubkeys + mode + bump + 5 u64/i64: the size every existing treasury has.
    assert.equal(data.length, 242);
    // Mode follows the six pubkeys; the old variants keep indices 0-3.
    assert.equal(data[8 + 6 * 32], index);
    assert.deepEqual(program.coder.accounts.decode("treasury", data).mode, { [mode]: {} });
  }
});
