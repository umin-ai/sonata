// SPDX-License-Identifier: GPL-3.0-or-later
// Stock Floor mode: half of each claim is retained as a floor that holders redeem
// by burning the community token. The creator can never withdraw it.
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

// Quote: 1000 units claimed. Base: 1000 units of supply, 600 with the holder and
// 400 elsewhere (standing in for tokens still on the curve).
async function fixture(mode = "floor") {
  const svm = new LiteSVM();
  svm.addProgramFromFile(id.toBase58(), "target/deploy/stockroom_treasury.so");
  const creator = Keypair.generate(),
    recipient = Keypair.generate(),
    holder = Keypair.generate(),
    attacker = Keypair.generate(),
    curve = Keypair.generate(),
    quote = Keypair.generate(),
    base = Keypair.generate(),
    pool = Keypair.generate().publicKey;
  for (const k of [creator, recipient, holder, attacker, curve])
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
    } else if (result instanceof FailedTransactionMetadata)
      throw Error(result.meta().logs().join("\n"));
  }
  const owners = [
    treasury,
    recipient.publicKey,
    creator.publicKey,
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
    mintTo(quote, treasury, 1000n, 8),
    mintTo(base, holder.publicKey, 600n, 6),
    mintTo(base, curve.publicKey, 400n, 6),
  ]);
  const data = await program.coder.accounts.encode("treasury", {
    pool,
    config: Keypair.generate().publicKey,
    quoteMint: quote.publicKey,
    baseMint: base.publicKey,
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
  const treasuryQuote = ata(quote, treasury);
  const distribute = () =>
    program.methods
      .distribute()
      .accounts({
        treasury,
        treasuryQuote,
        payoutQuote: ata(quote, recipient.publicKey),
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
  const redeem = (amount, signer = holder, over = {}) =>
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
        ...over,
      })
      .instruction();
  const data64 = (a, offset) =>
    Buffer.from(svm.getAccount(a.toBase58()).data).readBigUInt64LE(offset);
  const balance = (mint, owner) => data64(ata(mint, owner), 64);
  const supply = () => data64(base.publicKey, 36);
  const ledger = () =>
    program.coder.accounts.decode(
      "treasury",
      Buffer.from(svm.getAccount(treasury.toBase58()).data),
    );
  return {
    send,
    distribute,
    withdraw,
    redeem,
    balance,
    supply,
    ledger,
    ata,
    quote,
    base,
    treasury,
    creator,
    recipient,
    holder,
    attacker,
    curve,
  };
}

test("floor mode pays out half and retains half as the floor", async () => {
  const f = await fixture();
  await f.send(f.distribute(), f.attacker);
  assert.equal(f.balance(f.quote, f.recipient.publicKey), 500n);
  assert.equal(f.balance(f.quote, f.treasury), 500n);
  assert.equal(f.ledger().totalRetained.toString(), "500");
});

test("a holder burns tokens for exactly floor * amount / supply, and the floor per remaining token holds", async () => {
  const f = await fixture();
  await f.send(f.distribute());
  // 500 floor * 250 burned / 1000 supply = 125.
  await f.send(f.redeem(250), f.holder);
  assert.equal(f.balance(f.quote, f.holder.publicKey), 125n);
  assert.equal(f.balance(f.base, f.holder.publicKey), 350n);
  assert.equal(f.supply(), 750n);
  assert.equal(f.balance(f.quote, f.treasury), 375n);
  assert.equal(f.ledger().totalWithdrawn.toString(), "125");
  // 375 / 750 = 500 / 1000: the others' floor is unchanged.
  assert.equal(375n * 1000n, 500n * 750n);
});

test("rounding favours remaining holders and dust redemptions are refused", async () => {
  const f = await fixture();
  await f.send(f.distribute());
  // 500 * 1 / 1000 rounds to 0: refused rather than burning for nothing.
  await f.send(f.redeem(1), f.holder, /NothingToRedeem/);
  await f.send(f.redeem(0), f.holder, /NothingToRedeem/);
  // 500 * 3 / 1000 = 1.5, paid as 1.
  await f.send(f.redeem(3), f.holder);
  assert.equal(f.balance(f.quote, f.holder.publicKey), 1n);
  // Remaining floor per token did not fall: 499 / 997 >= 500 / 1000.
  assert.ok(499n * 1000n >= 500n * 997n);
  assert.equal(f.balance(f.base, f.holder.publicKey), 597n);
});

test("every holder redeeming everything never pays out more than the floor", async () => {
  const f = await fixture();
  await f.send(f.distribute());
  await f.send(f.redeem(600), f.holder);
  await f.send(f.redeem(400, f.curve), f.curve);
  const paid =
    f.balance(f.quote, f.holder.publicKey) +
    f.balance(f.quote, f.curve.publicKey);
  assert.equal(paid, 500n);
  assert.equal(f.balance(f.quote, f.treasury), 0n);
  assert.equal(f.supply(), 0n);
});

test("the creator can never withdraw the floor", async () => {
  const f = await fixture();
  await f.send(f.distribute());
  await f.send(f.withdraw(1), f.creator, /FloorLocked/);
  await f.send(f.withdraw(500), f.creator, /FloorLocked/);
  assert.equal(f.balance(f.quote, f.treasury), 500n);
});

test("only floor treasuries can be redeemed", async () => {
  const f = await fixture("duet");
  await f.send(f.distribute());
  await f.send(f.redeem(250), f.holder, /NotFloor/);
  // Duet keeps the creator withdrawal.
  await f.send(f.withdraw(100), f.creator);
  assert.equal(f.balance(f.quote, f.creator.publicKey), 100n);
});

test("an attacker cannot burn someone else's tokens, take their payout, or use another mint", async () => {
  const f = await fixture();
  await f.send(f.distribute());
  // Holder's tokens, attacker signing.
  await f.send(
    f.redeem(250, f.attacker, { holderBase: f.ata(f.base, f.holder.publicKey) }),
    f.attacker,
    /ConstraintTokenOwner/,
  );
  // Holder signing, payout redirected to the attacker.
  await f.send(
    f.redeem(250, f.holder, {
      holderQuote: f.ata(f.quote, f.attacker.publicKey),
    }),
    f.holder,
    /ConstraintTokenOwner/,
  );
  // A different mint posing as the community token.
  await f.send(
    f.redeem(250, f.holder, { baseMint: f.quote.publicKey }),
    f.holder,
    /ConstraintHasOne|ConstraintTokenMint/,
  );
  // More than the holder has.
  await f.send(f.redeem(601), f.holder, /insufficient funds/);
  assert.equal(f.balance(f.quote, f.treasury), 500n);
  assert.equal(f.balance(f.quote, f.attacker.publicKey), 0n);
  assert.equal(f.supply(), 1000n);
});

test("nothing is redeemable before a distribution retains a floor", async () => {
  const f = await fixture();
  await f.send(f.redeem(600), f.holder, /NothingToRedeem/);
});
