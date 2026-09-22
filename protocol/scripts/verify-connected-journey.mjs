// Read-only reconciliation of browser creator capital and reward transactions.
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { Connection, PublicKey } from "@solana/web3.js";
import { CpAmm, derivePositionNftAccount } from "@meteora-ag/cp-amm-sdk";
import {
  getAccount,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
const c = new Connection("https://api.devnet.solana.com", {
  commitment: "confirmed",
  fetch: async (...a) => {
    await new Promise((r) => setTimeout(r, 1100));
    return fetch(...a);
  },
});
assert.equal(
  await c.getGenesisHash(),
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
);
const p = new anchor.Program(
    JSON.parse(readFileSync("sdk/idl/stockroom_rewards.json")),
    { connection: c },
  ),
  t = new anchor.Program(
    JSON.parse(readFileSync("sdk/idl/stockroom_treasury.json")),
    { connection: c },
  ),
  amm = new CpAmm(c);
const wallet = "ACbRB4yPfUikHAaXhWzJXH4pjSPf6rk82Jot1JqRQ3Ft",
  position = "3WTQthKRanYwZAaYUFBUqfvU7a19wpKLTLV7JawieWNB",
  campaign = "DKxuabBy6yUHZ3nyQeuNR7WQnM8UzWfz2SV2sL8ddBT2",
  treasury = "8fTeNQk5x3FjuxEhc26PT7QgABr28tSQUU5WkZcL4xVW",
  mint = "6gat24puM23p74CeBKEPs53roxqpHcQpiGL8ZHtgNJqg";
const receipts = [];
const seen = new Set();
const scripted = JSON.parse(
  readFileSync("artifacts/stockroom-rewards-lifecycle.json"),
);
const signatures = [
  ...(
    await c.getSignaturesForAddress(
      new PublicKey(position),
      { limit: 8 },
      "confirmed",
    )
  ).map((r) => ({ signature: r.signature, group: "browser-capital" })),
  ...(
    await c.getSignaturesForAddress(
      new PublicKey(campaign),
      { limit: 8 },
      "confirmed",
    )
  ).map((r) => ({ signature: r.signature, group: "browser-rewards" })),
  ...scripted.receipts.map((r) => ({ ...r, group: "scripted-rewards" })),
];
for (const { signature, group } of signatures) {
  if (seen.has(signature)) continue;
  seen.add(signature);
  const tx = await c.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  assert(tx?.meta);
  assert.equal(tx.meta.err, null);
  const keys = tx.transaction.message.staticAccountKeys,
    byOwner = {};
  for (const row of tx.meta.preTokenBalances ?? []) {
    if (row.mint === mint)
      byOwner[row.owner] =
        (byOwner[row.owner] ?? 0n) - BigInt(row.uiTokenAmount.amount);
  }
  for (const row of tx.meta.postTokenBalances ?? []) {
    if (row.mint === mint)
      byOwner[row.owner] =
        (byOwner[row.owner] ?? 0n) + BigInt(row.uiTokenAmount.amount);
  }
  const decoded = tx.transaction.message.compiledInstructions
    .map((i) => {
      const id = keys[i.programIdIndex];
      const program = [p, t, amm._program].find((p) => p.programId.equals(id));
      return program?.coder.instruction.decode(Buffer.from(i.data))?.name;
    })
    .filter(Boolean);
  const row = {
    signature,
    group,
    slot: tx.slot,
    signer: keys[0].toBase58(),
    instructions: decoded,
    quoteDeltas: Object.fromEntries(
      Object.entries(byOwner).map(([k, v]) => [k, v.toString()]),
    ),
  };
  receipts.push(row);
  if (group === "browser-capital" && decoded.includes("addLiquidity")) {
    assert(decoded.includes("withdrawRetained"));
    assert(decoded.includes("createPosition"));
    assert.equal(row.quoteDeltas[treasury], "-100");
    assert.equal(row.quoteDeltas[wallet], "1");
  }
  if (group === "browser-rewards" && decoded.includes("fund")) {
    assert.equal(row.quoteDeltas[treasury], "-80");
    assert.equal(row.quoteDeltas[campaign], "80");
    assert.equal(row.quoteDeltas[wallet], "0");
  }
  if (group === "browser-rewards" && decoded.includes("claim")) {
    assert.equal(row.quoteDeltas[campaign], "-40");
    assert.equal(row.quoteDeltas[row.signer], "40");
  }
}
assert.equal(receipts.filter((r) => r.group === "browser-capital").length, 2);
assert.equal(receipts.filter((r) => r.group === "browser-rewards").length, 3);
assert.equal(receipts.length, 8);
const ps = await amm.fetchPositionState(new PublicKey(position)),
  nft = await getAccount(
    c,
    derivePositionNftAccount(ps.nftMint),
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
assert(nft.owner.equals(new PublicKey(wallet)));
assert.equal(nft.amount, 1n);
assert(ps.unlockedLiquidity.isZero());
const cs = await p.account.campaign.fetch(new PublicKey(campaign));
assert.equal(cs.claimedMask, 3);
assert.equal(cs.funded.toString(), "80");
assert.equal(cs.claimed.toString(), "80");
const escrow = await getAccount(
  c,
  getAssociatedTokenAddressSync(
    new PublicKey(mint),
    new PublicKey(campaign),
    true,
    TOKEN_2022_PROGRAM_ID,
  ),
  "confirmed",
  TOKEN_2022_PROGRAM_ID,
);
assert.equal(escrow.amount, 0n);
const ts = await t.account.treasury.fetch(new PublicKey(treasury));
assert.equal(
  BigInt(ts.totalRetained.toString()) - BigInt(ts.totalWithdrawn.toString()),
  20n,
);
const output = {
  verifiedAt: new Date().toISOString(),
  network: "devnet",
  creator: wallet,
  position,
  campaign,
  treasury,
  checks: {
    reserveDeploymentAtomic: true,
    creatorOwnedPositionFullyExited: true,
    rewardFundingAtomic: true,
    creatorWalletNotChargedRewardPrincipal: true,
    bothMembersPaidExactlyOnce: true,
    rewardEscrowEmpty: true,
    reserveRemainingRaw: "20",
  },
  receipts: receipts.sort((a, b) => a.slot - b.slot),
};
writeFileSync(
  "../cash-access/evidence/connected-journey.json",
  JSON.stringify(output, null, 2) + "\n",
);
console.log(output.checks, receipts.length + " transactions reconciled");
