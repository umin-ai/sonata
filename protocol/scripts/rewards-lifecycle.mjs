import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
const c = new Connection("https://api.devnet.solana.com", {
  commitment: "confirmed",
  fetch: async (...args) => {
    await new Promise((r) => setTimeout(r, 450));
    return fetch(...args);
  },
});
assert.equal(
  await c.getGenesisHash(),
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
);
const key = (n) =>
    Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(`.keys/${n}.json`))),
    ),
  creator = key("deployer"),
  alice = key("lp-alice"),
  bob = key("lp-bob"),
  attacker = key("lp-trader");
const m = JSON.parse(readFileSync("../cash-access/lib/treasury/market.json")),
  mint = new PublicKey(m.quoteMint),
  treasury = new PublicKey(m.treasury),
  t = new anchor.Program(
    JSON.parse(readFileSync("sdk/idl/stockroom_treasury.json")),
    { connection: c },
  ),
  p = new anchor.Program(
    JSON.parse(readFileSync("sdk/idl/stockroom_rewards.json")),
    { connection: c },
  ),
  bn = (n) => new anchor.BN(String(n)),
  ata = (owner) =>
    getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
const file = "artifacts/stockroom-rewards-lifecycle.json";
const e = existsSync(file)
  ? JSON.parse(readFileSync(file))
  : {
      network: "devnet",
      startedAt: new Date().toISOString(),
      nonce: String(Date.now()),
      receipts: [],
      checks: {},
    };
if (e.complete)
  throw Error("Already complete; inspect saved evidence, do not replay.");
const save = () => writeFileSync(file, JSON.stringify(e, null, 2) + "\n");
if (e.pending) {
  const status = (
    await c.getSignatureStatuses([e.pending.signature], {
      searchTransactionHistory: true,
    })
  ).value[0];
  if (status?.err)
    throw Error(
      "Previous transaction failed; inspect evidence before changing checkpoint.",
    );
  if (
    status?.confirmationStatus === "confirmed" ||
    status?.confirmationStatus === "finalized"
  ) {
    e.receipts.push(e.pending);
    delete e.pending;
    save();
  } else
    throw Error(
      "Unresolved pending receipt. Do not repeat a financial instruction.",
    );
}
const [campaign] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("rewards"),
    creator.publicKey.toBuffer(),
    bn(e.nonce).toArrayLike(Buffer, "le", 8),
  ],
  p.programId,
);
e.campaign = campaign.toBase58();
e.treasury = treasury.toBase58();
e.creator = creator.publicKey.toBase58();
e.recipients = [alice.publicKey.toBase58(), bob.publicKey.toBase58()];
save();
async function send(label, tx, signer) {
  if (e.receipts.some((r) => r.label === label)) return;
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 650000 }),
  );
  const latest = await c.getLatestBlockhash();
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = latest.blockhash;
  const sim = await c.simulateTransaction(
    new VersionedTransaction(tx.compileMessage()),
    { sigVerify: false, commitment: "confirmed" },
  );
  assert.equal(sim.value.err, null, sim.value.logs?.join("\n"));
  tx.sign(signer);
  const signature = anchor.utils.bytes.bs58.encode(tx.signature);
  e.pending = {
    label,
    signature,
    signer: signer.publicKey.toBase58(),
    ...latest,
  };
  save();
  await c.sendRawTransaction(tx.serialize(), {
    preflightCommitment: "confirmed",
  });
  const receipt = await c.confirmTransaction(
    { signature, ...latest },
    "confirmed",
  );
  assert.equal(receipt.value.err, null);
  e.receipts.push(e.pending);
  delete e.pending;
  save();
  console.log(label, signature);
}
const state = () => t.account.treasury.fetch(treasury),
  bal = async (owner) =>
    (await getAccount(c, ata(owner), "confirmed", TOKEN_2022_PROGRAM_ID))
      .amount;
if (!e.before) {
  const s = await state();
  assert(
    BigInt(s.totalRetained.toString()) - BigInt(s.totalWithdrawn.toString()) >=
      100n,
  );
  e.before = {
    withdrawn: s.totalWithdrawn.toString(),
    creatorBalance: (await bal(creator.publicKey)).toString(),
    treasuryBalance: (await bal(treasury)).toString(),
    alice: (await bal(alice.publicKey)).toString(),
    bob: (await bal(bob.publicKey)).toString(),
  };
  save();
}
const fund = await p.methods
  .fund(bn(e.nonce), [
    { recipient: alice.publicKey, amount: bn(40) },
    { recipient: bob.publicKey, amount: bn(60) },
  ])
  .accounts({
    creator: creator.publicKey,
    treasury,
    treasuryQuote: ata(treasury),
    creatorQuote: ata(creator.publicKey),
    mint,
    campaign,
    escrow: ata(campaign),
    treasuryProgram: t.programId,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .instruction();
await send("fund-reserve-rewards", new Transaction().add(fund), creator);
const claim = async (index, recipient) =>
  p.methods
    .claim(index)
    .accounts({
      campaign,
      escrow: ata(campaign),
      mint,
      recipient: recipient.publicKey,
      destination: ata(recipient.publicKey),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction();
async function reject(label, ix, signer) {
  const tx = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: (await c.getLatestBlockhash()).blockhash,
  }).add(ix);
  const s = await c.simulateTransaction(
    new VersionedTransaction(tx.compileMessage()),
    { sigVerify: false, commitment: "confirmed" },
  );
  assert(s.value.err);
  e.checks[label] = {
    error: s.value.err,
    logs: s.value.logs?.filter((x) => /Error|failed/i.test(x)).slice(-4),
  };
  save();
}
if (!e.checks.wrongRecipient)
  await reject("wrongRecipient", await claim(0, attacker), attacker);
await send("alice-claims", new Transaction().add(await claim(0, alice)), alice);
if (!e.checks.doubleClaim)
  await reject("doubleClaim", await claim(0, alice), alice);
await send("bob-claims", new Transaction().add(await claim(1, bob)), bob);
const after = await state(),
  ledger = await p.account.campaign.fetch(campaign);
assert.equal(
  BigInt(after.totalWithdrawn.toString()) - BigInt(e.before.withdrawn),
  100n,
);
assert.equal(BigInt(e.before.treasuryBalance) - (await bal(treasury)), 100n);
assert.equal(await bal(creator.publicKey), BigInt(e.before.creatorBalance));
assert.equal((await bal(alice.publicKey)) - BigInt(e.before.alice), 40n);
assert.equal((await bal(bob.publicKey)) - BigInt(e.before.bob), 60n);
assert.equal(await bal(campaign), 0n);
assert.equal(ledger.claimedMask, 3);
assert.equal(ledger.claimed.toString(), "100");
e.checks.exactReserveFundingAndClaims = true;
e.complete = true;
e.finishedAt = new Date().toISOString();
save();
console.log("Rewards lifecycle verified:", e.checks);
