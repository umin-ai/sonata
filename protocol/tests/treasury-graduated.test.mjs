// SPDX-License-Identifier: GPL-3.0-or-later
// After graduation the Vault owns a permanently locked position in the market's
// DAMM v2 pool. claim_graduated pulls that position's fees into the treasury, where
// the treasury's mode pays them out like any other claim. These tests cover the
// checks that decide which treasury may be credited: the pool must be a DAMM v2
// pool holding this market's token as A and its stock as B, and the program called
// must be DAMM v2. The DAMM v2 side of the call (position belongs to the pool, the
// Vault holds its NFT) is proven on Devnet by scripts/verify-graduated-claim.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { getTransactionDecoder } from "@solana/kit";
import { Keypair, PublicKey, Connection, Transaction, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";

const idl = JSON.parse(readFileSync("target/idl/stockroom_treasury.json")),
  id = new PublicKey(idl.address),
  bn = (n) => new anchor.BN(String(n));
const DAMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const POOL_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188];
const [VAULT, VAULT_BUMP] = PublicKey.findProgramAddressSync([Buffer.from("stockroom")], id);

async function fixture() {
  const svm = new LiteSVM();
  svm.addProgramFromFile(id.toBase58(), "target/deploy/stockroom_treasury.so");
  // A stand-in executable at DAMM v2's address: the checks under test run before the call.
  svm.addProgramFromFile(DAMM.toBase58(), "target/deploy/demo_oracle.so");
  const payer = Keypair.generate(),
    quote = Keypair.generate(),
    base = Keypair.generate(),
    other = Keypair.generate(),
    pool = Keypair.generate().publicKey;
  svm.airdrop(payer.publicKey.toBase58(), 10_000_000_000n);
  const program = new anchor.Program(
    idl,
    new anchor.AnchorProvider(new Connection("http://127.0.0.1:8899"), new anchor.Wallet(payer), {}),
  );
  const [treasury, bump] = PublicKey.findProgramAddressSync([Buffer.from("treasury"), pool.toBuffer()], id);
  const ata = (mint, owner) => getAssociatedTokenAddressSync(mint.publicKey, owner, true);
  const send = async (ixs, signers = []) => {
    svm.expireBlockhash();
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: svm.latestBlockhash() }).add(
      ...(await Promise.all(ixs)),
    );
    tx.sign(payer, ...signers);
    return svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
  };
  for (const [mint, decimals] of [
    [quote, 8],
    [base, 6],
    [other, 6],
  ]) {
    const r = await send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          space: MINT_SIZE,
          lamports: 2_000_000,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint.publicKey, decimals, payer.publicKey, null),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(mint, treasury), treasury, mint.publicKey),
      ],
      [mint],
    );
    assert(!(r instanceof FailedTransactionMetadata), "mint setup failed");
  }
  const put = (address, owner, data) =>
    svm.setAccount({
      address: address.toBase58(),
      programAddress: owner.toBase58(),
      lamports: 10_000_000n,
      executable: false,
      data,
      space: BigInt(data.length),
    });
  put(VAULT, id, await program.coder.accounts.encode("vault", { admin: payer.publicKey, bump: VAULT_BUMP, treasuries: bn(1) }));
  put(
    treasury,
    id,
    await program.coder.accounts.encode("treasury", {
      pool,
      config: Keypair.generate().publicKey,
      quoteMint: quote.publicKey,
      baseMint: base.publicKey,
      creator: payer.publicKey,
      payoutOwner: payer.publicKey,
      mode: { standard: {} },
      bump,
      totalClaimed: bn(0),
      totalDistributed: bn(0),
      totalRetained: bn(0),
      totalWithdrawn: bn(0),
      lastClaimTs: bn(0),
    }),
  );
  // A DAMM v2 pool account: 1,112 bytes, token A mint at 168, token B mint at 200.
  const dammPool = (a, b, owner = DAMM, discriminator = POOL_DISCRIMINATOR) => {
    const address = Keypair.generate().publicKey;
    const data = new Uint8Array(1112);
    data.set(discriminator, 0);
    data.set(a.toBytes(), 168);
    data.set(b.toBytes(), 200);
    put(address, owner, data);
    return address;
  };
  const claim = (poolAddress, over = {}) =>
    send([
      program.methods
        .claimGraduated()
        .accountsStrict({
          vault: VAULT,
          treasury,
          dammPoolAuthority: new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"),
          dammPool: poolAddress,
          position: Keypair.generate().publicKey,
          treasuryBase: ata(base, treasury),
          treasuryQuote: ata(quote, treasury),
          tokenAVault: Keypair.generate().publicKey,
          tokenBVault: Keypair.generate().publicKey,
          baseMint: base.publicKey,
          quoteMint: quote.publicKey,
          positionNftAccount: Keypair.generate().publicKey,
          tokenBaseProgram: TOKEN_PROGRAM_ID,
          tokenQuoteProgram: TOKEN_PROGRAM_ID,
          dammEventAuthority: Keypair.generate().publicKey,
          dammProgram: DAMM,
          ...over,
        })
        .instruction(),
    ]);
  return { quote, base, other, dammPool, claim };
}

const logs = (r) => r.meta().logs().join("\n");

test("claim_graduated refuses a pool that is not DAMM v2's", async () => {
  const f = await fixture();
  const fake = f.dammPool(f.base.publicKey, f.quote.publicKey, TOKEN_PROGRAM_ID);
  const r = await f.claim(fake);
  assert(r instanceof FailedTransactionMetadata);
  assert.match(logs(r), /InvalidPool/);
});

test("claim_graduated refuses a DAMM v2 account that is not a pool", async () => {
  const f = await fixture();
  const notPool = f.dammPool(f.base.publicKey, f.quote.publicKey, undefined, [170, 188, 143, 228, 122, 64, 247, 208]);
  const r = await f.claim(notPool);
  assert(r instanceof FailedTransactionMetadata);
  assert.match(logs(r), /InvalidPool/);
});

test("claim_graduated refuses another market's pool, or the same mints swapped", async () => {
  const f = await fixture();
  for (const [a, b] of [
    [f.other.publicKey, f.quote.publicKey],
    [f.base.publicKey, f.other.publicKey],
    [f.quote.publicKey, f.base.publicKey],
  ]) {
    const r = await f.claim(f.dammPool(a, b));
    assert(r instanceof FailedTransactionMetadata);
    assert.match(logs(r), /InvalidPool/);
  }
});

test("claim_graduated only calls DAMM v2", async () => {
  const f = await fixture();
  const r = await f.claim(f.dammPool(f.base.publicKey, f.quote.publicKey), { dammProgram: TOKEN_PROGRAM_ID });
  assert(r instanceof FailedTransactionMetadata);
  assert.match(logs(r), /ConstraintAddress|2012/);
});

test("the market's own pool passes the checks and reaches DAMM v2, signed by the Vault", async () => {
  const f = await fixture();
  const r = await f.claim(f.dammPool(f.base.publicKey, f.quote.publicKey));
  // The stand-in program at DAMM v2's address rejects the call; reaching it means
  // every check in claim_graduated passed.
  assert(r instanceof FailedTransactionMetadata);
  assert.doesNotMatch(logs(r), /InvalidPool/);
  assert.match(logs(r), new RegExp(`Program ${DAMM.toBase58()} invoke`));
});
