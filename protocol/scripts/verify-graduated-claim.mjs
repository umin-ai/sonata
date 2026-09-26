// SPDX-License-Identifier: GPL-3.0-or-later
// Proves Sonata keeps collecting after graduation: a trade on a graduated DAMM v2
// pool earns fees for the Vault's permanently locked position, and claim_graduated
// moves them into that market's treasury (total_claimed grows by exactly what
// arrived), from where its mode pays them out like any other claim. The locked
// liquidity stays locked.
//
// Usage: node scripts/verify-graduated-claim.mjs [creator-position-proof.json] [out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, ComputeBudgetProgram, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import anchor from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { CpAmm, SwapMode } from "@meteora-ag/cp-amm-sdk";
import assert from "node:assert/strict";

const proofPath = process.argv[2] ?? "artifacts/creator-position-proof.json";
const out = process.argv[3] ?? "artifacts/graduated-claim-proof.json";
const IN_ATOMS = 10_000_000n; // 0.1 of the mock stock
const DAMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const DAMM_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const conn = new Connection("https://api.devnet.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
assert.equal(await conn.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "Not Devnet.");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/deployer.json"))));
const program = new anchor.Program(
  JSON.parse(readFileSync("target/idl/stockroom_treasury.json")),
  new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" }),
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The public Devnet RPC rate-limits heavy calls: back off and retry.
async function retry(fn, tries = 6) {
  for (let i = 0; ; i++)
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !/429|Too many/i.test(String(e))) throw e;
      await sleep(2000 * 2 ** i);
    }
}
const proof = JSON.parse(readFileSync(proofPath));
const pk = (s) => new PublicKey(s);
const dammPool = pk(proof.dammPool),
  treasury = pk(proof.treasury),
  baseMint = pk(proof.baseMint),
  quoteMint = pk(proof.quoteMint);
const [vault] = PublicKey.findProgramAddressSync([Buffer.from("stockroom")], program.programId);
const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DAMM);
const treasuryBase = getAssociatedTokenAddressSync(baseMint, treasury, true, TOKEN_PROGRAM_ID);
const treasuryQuote = getAssociatedTokenAddressSync(quoteMint, treasury, true, TOKEN_2022_PROGRAM_ID);
const amm = new CpAmm(conn);
const traces = [];
const send = async (label, tx) => {
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  const signature = await retry(() => sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed" }));
  traces.push({ label, signature });
  console.log(`${label}: ${signature}`);
  return signature;
};

// 1. A trade on the graduated pool, so the Vault's position has fees to claim.
const s = await retry(() => amm.fetchPoolState(dammPool));
assert.ok(s.tokenAMint.equals(baseMint) && s.tokenBMint.equals(quoteMint), "Pool does not hold this market's token and stock.");
const time = await conn.getBlockTime(await conn.getSlot("confirmed"));
const q = amm.getQuote2({
  poolState: s, inputTokenMint: s.tokenBMint, amountIn: new BN(IN_ATOMS.toString()), slippage: 100,
  currentPoint: new BN(time), tokenADecimal: 6, tokenBDecimal: 8, hasReferral: false, swapMode: SwapMode.ExactIn,
});
await send(
  "Buy 0.1 on the graduated DAMM v2 pool",
  await amm.swap({
    payer: admin.publicKey, pool: dammPool,
    tokenAMint: s.tokenAMint, tokenBMint: s.tokenBMint, tokenAVault: s.tokenAVault, tokenBVault: s.tokenBVault,
    tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_2022_PROGRAM_ID,
    inputTokenMint: s.tokenBMint, outputTokenMint: s.tokenAMint,
    amountIn: new BN(IN_ATOMS.toString()), minimumAmountOut: q.minimumAmountOut,
    referralTokenAccount: null, poolState: s,
  }),
);

// 2. The Vault's position: the Vault holds its NFT (in DAMM v2's position NFT account).
const held = await retry(() => amm.getUserPositionByPool(dammPool, vault));
const found = held[0]
  ? { position: held[0].position, nft: held[0].positionState.nftMint, nftAccount: held[0].positionNftAccount }
  : null;
assert.ok(found, "No position in this pool is held by the Vault.");
const lockedBefore = (await retry(() => amm.fetchPositionState(found.position))).permanentLockedLiquidity.toString();

// 3. Claim into the treasury.
const quoteBal = async () => BigInt((await getAccount(conn, treasuryQuote, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);
const t0 = await program.account.treasury.fetch(treasury);
const before = await quoteBal();
await send(
  "claim_graduated: the Vault's locked-position fees into the treasury",
  new Transaction().add(
    await program.methods
      .claimGraduated()
      .accountsStrict({
        vault, treasury, dammPoolAuthority: DAMM_POOL_AUTHORITY, dammPool, position: found.position,
        treasuryBase, treasuryQuote, tokenAVault: s.tokenAVault, tokenBVault: s.tokenBVault, baseMint, quoteMint,
        positionNftAccount: found.nftAccount, tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
        dammEventAuthority: eventAuthority, dammProgram: DAMM,
      })
      .instruction(),
  ),
);
const t1 = await program.account.treasury.fetch(treasury);
const arrived = (await quoteBal()) - before;
const claimed = BigInt(t1.totalClaimed.sub(t0.totalClaimed).toString());
const lockedAfter = (await retry(() => amm.fetchPositionState(found.position))).permanentLockedLiquidity.toString();
const checks = {
  feesArrived: arrived > 0n,
  totalClaimedGrewByExactlyWhatArrived: claimed === arrived,
  liquidityStillLocked: lockedAfter === lockedBefore && lockedAfter !== "0",
};
console.log({ arrived: arrived.toString(), claimed: claimed.toString(), position: found.position.toBase58(), checks });
for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Verification failed: ${name}`);
writeFileSync(
  out,
  JSON.stringify(
    {
      network: "solana:devnet",
      createdAt: new Date().toISOString(),
      intent: "After graduation, claim the Vault's locked-position fees from DAMM v2 into the market's treasury.",
      dammPool: dammPool.toBase58(), treasury: treasury.toBase58(), vault: vault.toBase58(),
      position: found.position.toBase58(), positionNft: found.nft.toBase58(),
      tradeIn: IN_ATOMS.toString(), feesClaimed: arrived.toString(), permanentLockedLiquidity: lockedAfter,
      checks, traces,
    },
    null,
    2,
  ) + "\n",
);
console.log(`\nAll checks passed. ${out}`);
