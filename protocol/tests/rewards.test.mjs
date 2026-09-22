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
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MintLayout,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
const idl = JSON.parse(readFileSync("target/idl/stockroom_rewards.json")),
  tidl = JSON.parse(readFileSync("target/idl/stockroom_treasury.json"));
const id = new PublicKey(idl.address),
  tid = new PublicKey(tidl.address),
  mint = new PublicKey("6gat24puM23p74CeBKEPs53roxqpHcQpiGL8ZHtgNJqg"),
  bn = (n) => new anchor.BN(String(n));
async function fixture() {
  const svm = new LiteSVM();
  svm.addProgramFromFile(id.toBase58(), "target/deploy/stockroom_rewards.so");
  svm.addProgramFromFile(tid.toBase58(), "target/deploy/stockroom_treasury.so");
  const creator = Keypair.generate(),
    alice = Keypair.generate(),
    bob = Keypair.generate(),
    attacker = Keypair.generate();
  for (const k of [creator, alice, bob, attacker])
    svm.airdrop(k.publicKey.toBase58(), 10_000_000_000n);
  const provider = new anchor.AnchorProvider(
      new Connection("http://127.0.0.1:8899"),
      new anchor.Wallet(creator),
      {},
    ),
    p = new anchor.Program(idl, provider),
    t = new anchor.Program(tidl, provider);
  const put = (key, owner, data) =>
    svm.setAccount({
      address: key.toBase58(),
      programAddress: owner.toBase58(),
      data,
      lamports: 100_000_000n,
      executable: false,
      space: BigInt(data.length),
    });
  const md = Buffer.alloc(82);
  MintLayout.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority: creator.publicKey,
      supply: 1000n,
      decimals: 8,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    md,
  );
  put(mint, TOKEN_2022_PROGRAM_ID, md);
  const pool = Keypair.generate().publicKey,
    [treasury, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), pool.toBuffer()],
      tid,
    );
  const ata = (owner) =>
    getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
  const campaign = (nonce = 1, owner = creator.publicKey) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("rewards"),
        owner.toBuffer(),
        bn(nonce).toArrayLike(Buffer, "le", 8),
      ],
      id,
    )[0];
  async function send(ix, signer = creator, error) {
    svm.expireBlockhash();
    const tx = new Transaction({
      feePayer: signer.publicKey,
      recentBlockhash: svm.latestBlockhash(),
    }).add(...(await Promise.all(Array.isArray(ix) ? ix : [ix])));
    tx.sign(signer);
    const r = svm.sendTransaction(
      getTransactionDecoder().decode(tx.serialize()),
    );
    if (error) {
      assert(r instanceof FailedTransactionMetadata);
      assert.match(r.meta().logs().join("\n"), error);
    } else if (r instanceof FailedTransactionMetadata)
      throw Error(r.meta().logs().join("\n"));
  }
  await send(
    [
      creator.publicKey,
      treasury,
      alice.publicKey,
      bob.publicKey,
      attacker.publicKey,
    ].map((o) =>
      createAssociatedTokenAccountIdempotentInstruction(
        creator.publicKey,
        ata(o),
        o,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
    ),
  );
  const treasuryData = await t.coder.accounts.encode("treasury", {
    pool,
    config: PublicKey.default,
    quoteMint: mint,
    baseMint: PublicKey.default,
    creator: creator.publicKey,
    payoutOwner: alice.publicKey,
    mode: { duet: {} },
    bump,
    totalClaimed: bn(2000),
    totalDistributed: bn(1000),
    totalRetained: bn(1000),
    totalWithdrawn: bn(0),
    lastClaimTs: bn(0),
  });
  put(treasury, tid, treasuryData);
  const td = Buffer.from(svm.getAccount(ata(treasury).toBase58()).data);
  td.writeBigUInt64LE(1000n, 64);
  put(ata(treasury), TOKEN_2022_PROGRAM_ID, td);
  const allocations = [
    { recipient: alice.publicKey, amount: bn(200) },
    { recipient: bob.publicKey, amount: bn(400) },
  ];
  const fund = (as = allocations, nonce = 1, signer = creator) =>
    p.methods
      .fund(bn(nonce), as)
      .accounts({
        creator: signer.publicKey,
        treasury,
        treasuryQuote: ata(treasury),
        creatorQuote: ata(signer.publicKey),
        mint,
        campaign: campaign(nonce, signer.publicKey),
        escrow: ata(campaign(nonce, signer.publicKey)),
        treasuryProgram: tid,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  const claim = (
    index,
    signer = alice,
    destination = ata(signer.publicKey),
    nonce = 1,
  ) =>
    p.methods
      .claim(index)
      .accounts({
        campaign: campaign(nonce),
        escrow: ata(campaign(nonce)),
        mint,
        recipient: signer.publicKey,
        destination,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
  const bal = (a) =>
      Buffer.from(svm.getAccount(a.toBase58()).data).readBigUInt64LE(64),
    state = () =>
      p.coder.accounts.decode(
        "campaign",
        Buffer.from(svm.getAccount(campaign().toBase58()).data),
      );
  return {
    svm,
    p,
    put,
    send,
    creator,
    alice,
    bob,
    attacker,
    ata,
    treasury,
    campaign,
    allocations,
    fund,
    claim,
    bal,
    state,
    t,
  };
}
test("reserve funds escrow atomically; two independent recipients claim exact amounts once", async () => {
  const f = await fixture();
  await f.send(f.fund());
  assert.equal(f.bal(f.ata(f.treasury)), 400n);
  assert.equal(f.bal(f.ata(f.creator.publicKey)), 0n);
  assert.equal(f.bal(f.ata(f.campaign())), 600n);
  await f.send(f.claim(0), f.alice);
  await f.send(f.claim(1, f.bob), f.bob);
  assert.equal(f.bal(f.ata(f.alice.publicKey)), 200n);
  assert.equal(f.bal(f.ata(f.bob.publicKey)), 400n);
  assert.equal(f.bal(f.ata(f.campaign())), 0n);
  assert.equal(f.state().claimed.toString(), "600");
  assert.equal(f.state().claimedMask, 3);
  await f.send(f.claim(0), f.alice, /AlreadyClaimed/);
});
test("wrong recipient, redirected destination and invalid index cannot take funds", async () => {
  const f = await fixture();
  await f.send(f.fund());
  await f.send(f.claim(0, f.attacker), f.attacker, /WrongRecipient/);
  await f.send(
    f.claim(0, f.alice, f.ata(f.attacker.publicKey)),
    f.alice,
    /ConstraintTokenOwner/,
  );
  await f.send(f.claim(8), f.alice, /InvalidAllocation/);
  assert.equal(f.state().claimedMask, 0);
  assert.equal(f.bal(f.ata(f.campaign())), 600n);
});
test("overfunding rolls back account creation and reserve withdrawal", async () => {
  const f = await fixture();
  await f.send(
    f.fund([{ recipient: f.alice.publicKey, amount: bn(1001) }]),
    f.creator,
    /NothingToRoute/,
  );
  assert.equal(f.bal(f.ata(f.treasury)), 1000n);
  assert.equal(f.bal(f.ata(f.creator.publicKey)), 0n);
  assert.equal(f.svm.getAccount(f.campaign().toBase58()).exists, false);
});
test("creator identity, unique recipients, positive amounts and maximum membership enforced", async () => {
  const f = await fixture();
  await f.send(
    f.fund(undefined, 1, f.attacker),
    f.attacker,
    /ConstraintHasOne/,
  );
  for (const allocation of [
    [],
    [{ recipient: f.alice.publicKey, amount: bn(0) }],
    Array.from({ length: 9 }, () => ({
      recipient: Keypair.generate().publicKey,
      amount: bn(1),
    })),
  ])
    await f.send(f.fund(allocation), f.creator, /InvalidAllocation/);
  await f.send(
    f.fund([f.allocations[0], f.allocations[0]]),
    f.creator,
    /DuplicateRecipient/,
  );
  assert.equal(f.bal(f.ata(f.treasury)), 1000n);
});
test("failed token transfer cannot mark a grant claimed", async () => {
  const f = await fixture();
  await f.send(f.fund());
  const dest = f.ata(f.alice.publicKey),
    data = Buffer.from(f.svm.getAccount(dest.toBase58()).data);
  data[108] = 2;
  f.put(dest, TOKEN_2022_PROGRAM_ID, data);
  await f.send(f.claim(0), f.alice, /frozen|Frozen/i);
  assert.equal(f.state().claimedMask, 0);
  assert.equal(f.bal(f.ata(f.campaign())), 600n);
});
test("a failure after escrow funding rolls back the CPI reserve debit, ledger and new accounts", async () => {
  const f = await fixture();
  await f.send(
    [
      f.fund(),
      SystemProgram.transfer({
        fromPubkey: f.creator.publicKey,
        toPubkey: f.attacker.publicKey,
        lamports: 20_000_000_000,
      }),
    ],
    f.creator,
    /insufficient lamports|insufficient funds/i,
  );
  assert.equal(f.bal(f.ata(f.treasury)), 1000n);
  assert.equal(f.bal(f.ata(f.creator.publicKey)), 0n);
  assert.equal(f.svm.getAccount(f.campaign().toBase58()).exists, false);
  const t = f.t.coder.accounts.decode(
    "treasury",
    Buffer.from(f.svm.getAccount(f.treasury.toBase58()).data),
  );
  assert.equal(t.totalWithdrawn.toString(), "0");
});

const policyKey = (f) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("holder-policy"), f.treasury.toBuffer()],
    id,
  )[0];
const roundKey = (f) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("holder-round"), f.campaign().toBuffer()],
    id,
  )[0];
const policyIx = (f, share = 5000, signer = f.creator) =>
  f.p.methods
    .createPolicy(share, bn(60))
    .accounts({
      creator: signer.publicKey,
      treasury: f.treasury,
      policy: policyKey(f),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
const recordIx = (f, slot = 0) =>
  f.p.methods
    .recordRound(bn(slot), Array(32).fill(1))
    .accounts({
      instructions: new PublicKey(
        "Sysvar1nstructions1111111111111111111111111",
      ),
      creator: f.creator.publicKey,
      treasury: f.treasury,
      policy: policyKey(f),
      campaign: f.campaign(),
      round: roundKey(f),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
const deliverIx = (
  f,
  index,
  recipient = f.alice.publicKey,
  destination = f.ata(recipient),
) =>
  f.p.methods
    .deliver(index)
    .accounts({
      payer: f.attacker.publicKey,
      campaign: f.campaign(),
      escrow: f.ata(f.campaign()),
      mint,
      recipient,
      destination,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction();
test("permissionless delivery pays fixed holder without their signature and rejects repeats", async () => {
  const f = await fixture();
  await f.send(f.fund());
  await f.send(deliverIx(f, 0), f.attacker);
  assert.equal(f.bal(f.ata(f.alice.publicKey)), 200n);
  await f.send(deliverIx(f, 0), f.attacker, /AlreadyClaimed/);
  await f.send(
    deliverIx(f, 1, f.attacker.publicKey),
    f.attacker,
    /WrongRecipient/,
  );
  await f.send(
    deliverIx(f, 1, f.bob.publicKey, f.ata(f.attacker.publicKey)),
    f.attacker,
    /ConstraintTokenOwner/,
  );
  assert.equal(f.bal(f.ata(f.attacker.publicKey)), 0n);
});
test("policy owner, fee share and cadence are enforced", async () => {
  const f = await fixture();
  await f.send(policyIx(f, 5000, f.attacker), f.attacker, /ConstraintHasOne/);
  await f.send(policyIx(f, 10001), f.creator, /InvalidPolicy/);
  await f.send(policyIx(f));
  const p = f.p.coder.accounts.decode(
    "holderPolicy",
    Buffer.from(f.svm.getAccount(policyKey(f).toBase58()).data),
  );
  assert.equal(p.checkpoint.toString(), "1000");
  assert.equal(p.shareBps, 5000);
});
test("round budget uses new fees and rejects stale snapshots atomically", async () => {
  const f = await fixture();
  const clock = f.svm.getClock();
  clock.unixTimestamp = 1000n;
  clock.slot = 500n;
  f.svm.setClock(clock);
  await f.send(policyIx(f));
  const treasury = f.t.coder.accounts.decode(
    "treasury",
    Buffer.from(f.svm.getAccount(f.treasury.toBase58()).data),
  );
  treasury.totalRetained = bn(2200);
  treasury.totalClaimed = bn(3200);
  f.put(f.treasury, tid, await f.t.coder.accounts.encode("treasury", treasury));
  const tokenData = Buffer.from(
    f.svm.getAccount(f.ata(f.treasury).toBase58()).data,
  );
  tokenData.writeBigUInt64LE(2200n, 64);
  f.put(f.ata(f.treasury), TOKEN_2022_PROGRAM_ID, tokenData);
  await f.send(
    [
      f.fund([{ recipient: f.alice.publicKey, amount: bn(599) }]),
      recordIx(f, 500),
    ],
    f.creator,
    /InvalidAllocation/,
  );
  await f.send([f.fund(), recordIx(f, 1)], f.creator, /StaleSnapshot/);
  assert.equal(f.svm.getAccount(f.campaign().toBase58()).exists, false);
  await f.send([f.fund(), recordIx(f, 500)]);
  const p = f.p.coder.accounts.decode(
    "holderPolicy",
    Buffer.from(f.svm.getAccount(policyKey(f).toBase58()).data),
  );
  assert.equal(p.checkpoint.toString(), "2200");
  assert.equal(p.rounds.toString(), "1");
  assert.equal(f.bal(f.ata(f.campaign())), 600n);
});
test('old grants cannot be relabelled as newly funded holder rounds',async()=>{
 const f=await fixture();await f.send(policyIx(f));await f.send(f.fund());
 await f.send(recordIx(f),f.creator,/InvalidAllocation/);
 assert.equal(f.svm.getAccount(roundKey(f).toBase58()).exists,false);
});
test('paused policy refuses a holder round and rolls back funding',async()=>{
 const f=await fixture();await f.send(policyIx(f));
 await f.send(f.p.methods.updatePolicy(0,bn(60)).accounts({creator:f.creator.publicKey,treasury:f.treasury,policy:policyKey(f)}).instruction());
 await f.send([f.fund(),recordIx(f)],f.creator,/NotDue/);
 assert.equal(f.bal(f.ata(f.treasury)),1000n);
 assert.equal(f.svm.getAccount(f.campaign().toBase58()).exists,false);
});
