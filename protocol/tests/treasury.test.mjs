// SPDX-License-Identifier: GPL-3.0-or-later
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
async function fixture(mode = "duet") {
  const svm = new LiteSVM();
  svm.addProgramFromFile(id.toBase58(), "target/deploy/stockroom_treasury.so");
  const creator = Keypair.generate(),
    recipient = Keypair.generate(),
    attacker = Keypair.generate(),
    mint = Keypair.generate(),
    pool = Keypair.generate().publicKey;
  for (const k of [creator, recipient, attacker])
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
  const ata = (owner) =>
    getAssociatedTokenAddressSync(mint.publicKey, owner, true);
  const treasuryQuote = ata(treasury),
    payoutQuote = ata(recipient.publicKey),
    creatorQuote = ata(creator.publicKey),
    attackerQuote = ata(attacker.publicKey);
  async function send(ixs, signer = creator, error) {
    svm.expireBlockhash();
    const tx = new Transaction({
      feePayer: signer.publicKey,
      recentBlockhash: svm.latestBlockhash(),
    }).add(...(await Promise.all(Array.isArray(ixs) ? ixs : [ixs])));
    tx.sign(
      signer,
      ...(tx.instructions.some((i) =>
        i.keys.some((k) => k.isSigner && k.pubkey.equals(mint.publicKey)),
      )
        ? [mint]
        : []),
    );
    const result = svm.sendTransaction(
      getTransactionDecoder().decode(tx.serialize()),
    );
    if (error) {
      assert(result instanceof FailedTransactionMetadata);
      assert.match(result.meta().logs().join("\n"), error);
    } else if (result instanceof FailedTransactionMetadata)
      throw Error(result.meta().logs().join("\n"));
  }
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
      6,
      creator.publicKey,
      null,
    ),
    ...[
      treasury,
      recipient.publicKey,
      creator.publicKey,
      attacker.publicKey,
    ].map((o) =>
      createAssociatedTokenAccountIdempotentInstruction(
        creator.publicKey,
        ata(o),
        o,
        mint.publicKey,
      ),
    ),
    createMintToCheckedInstruction(
      mint.publicKey,
      treasuryQuote,
      creator.publicKey,
      1000n,
      6,
    ),
  ]);
  const data = await program.coder.accounts.encode("treasury", {
    pool,
    config: Keypair.generate().publicKey,
    quoteMint: mint.publicKey,
    baseMint: Keypair.generate().publicKey,
    creator: creator.publicKey,
    payoutOwner: recipient.publicKey,
    mode: { [mode]: {} },
    bump,
    totalClaimed: bn(1000),
    totalDistributed: bn(0),
    totalRetained: bn(0),
    totalWithdrawn: bn(0),
    lastClaimTs: bn(0),
  });
  svm.setAccount({
    address: treasury.toBase58(),
    programAddress: id.toBase58(),
    lamports: 10_000_000n,
    executable: false,
    data,
    space: BigInt(data.length),
  });
  const base = {
    treasury,
    treasuryQuote,
    quoteMint: mint.publicKey,
    tokenQuoteProgram: TOKEN_PROGRAM_ID,
  };
  const distribute = (dest = payoutQuote) =>
    program.methods
      .distribute()
      .accounts({ ...base, payoutQuote: dest })
      .instruction();
  const withdraw = (amount, signer = creator, dest = creatorQuote) =>
    program.methods
      .withdrawRetained(bn(amount))
      .accounts({ ...base, creator: signer.publicKey, creatorQuote: dest })
      .instruction();
  const balance = (a) =>
    Buffer.from(svm.getAccount(a.toBase58()).data).readBigUInt64LE(64);
  const ledger = () =>
    program.coder.accounts.decode(
      "treasury",
      Buffer.from(svm.getAccount(treasury.toBase58()).data),
    );
  return {
    send,
    distribute,
    withdraw,
    balance,
    ledger,
    treasuryQuote,
    payoutQuote,
    creatorQuote,
    attackerQuote,
    creator,
    attacker,
  };
}
test("fixed payout + retained custody conserve tokens; only creator can recover retained assets", async () => {
  const f = await fixture();
  await f.send(f.distribute(), f.attacker);
  assert.equal(f.balance(f.payoutQuote), 500n);
  assert.equal(f.balance(f.treasuryQuote), 500n);
  await f.send(f.withdraw(200));
  assert.equal(f.balance(f.creatorQuote), 200n);
  assert.equal(f.balance(f.treasuryQuote), 300n);
  assert.equal(f.ledger().totalWithdrawn.toString(), "200");
  await f.send(f.withdraw(300));
  assert.equal(f.balance(f.treasuryQuote), 0n);
});
test("an attacker cannot redirect the payout, impersonate the creator, redirect withdrawals, or replay distribution", async () => {
  const f = await fixture();
  await f.send(f.distribute(f.attackerQuote), f.attacker, /InvalidRecipient/);
  assert.equal(f.balance(f.treasuryQuote), 1000n);
  await f.send(f.distribute());
  await f.send(
    f.withdraw(100, f.attacker, f.attackerQuote),
    f.attacker,
    /ConstraintHasOne/,
  );
  await f.send(
    f.withdraw(100, f.creator, f.attackerQuote),
    f.creator,
    /ConstraintTokenOwner/,
  );
  await f.send(f.distribute(), f.creator, /NothingToDistribute/);
  assert.equal(f.balance(f.treasuryQuote), 500n);
  assert.equal(f.balance(f.attackerQuote), 0n);
});
test("unallocated funds cannot be withdrawn and retained capital cannot be overdrawn", async () => {
  const f = await fixture();
  await f.send(f.withdraw(1), f.creator, /NothingToRoute/);
  await f.send(f.distribute());
  await f.send(f.withdraw(501), f.creator, /NothingToRoute/);
  await f.send(f.withdraw(0), f.creator, /NothingToRoute/);
  assert.equal(f.balance(f.treasuryQuote), 500n);
});
for (const [mode, payout] of [
  ["refrain", 1000n],
  ["sustain", 0n],
])
  test(`${mode} distribution follows its immutable split`, async () => {
    const f = await fixture(mode);
    await f.send(f.distribute());
    assert.equal(f.balance(f.payoutQuote), payout);
    assert.equal(f.balance(f.treasuryQuote), 1000n - payout);
  });
