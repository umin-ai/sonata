// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToCheckedInstruction, getAccount } from '@solana/spl-token';
import { createClient, DEVNET_GENESIS, positionAddress } from '../sdk/client.mjs';
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
assert.equal(await conn.getGenesisHash(), DEVNET_GENESIS);
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.keys/app-demo/authority.json'))));
const registry = JSON.parse(readFileSync('artifacts/mock-markets.json'));
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: 'confirmed' });
const clients = registry.markets.map(m => createClient(JSON.parse(readFileSync('sdk/idl/stockroom_credit.json')), JSON.parse(readFileSync('sdk/idl/demo_oracle.json')), provider, { admin: admin.publicKey, collateralMint: new PublicKey(m.collateralMint), debtMint: new PublicKey(m.debtMint), oracleAccount: new PublicKey(m.oracleAccount) }));
const output = 'artifacts/mock-market-lifecycle.json';
if (existsSync(output)) throw Error('Evidence already exists; inspect it before rerunning a funded verification.');
const wallet = Keypair.generate();
writeFileSync('.keys/app-demo/market-verification-wallet.json', JSON.stringify([...wallet.secretKey]), { mode: 0o600, flag: 'wx' });
const evidence = { date: new Date().toISOString(), network: 'solana:devnet', wallet: wallet.publicKey.toBase58(), steps: [], assertions: [] };
const save = () => writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
save();
async function send(m, action, ixs, signers = [wallet]) {
  const block = await conn.getLatestBlockhash();
  const tx = new Transaction({ feePayer: signers[0].publicKey, ...block }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ...await Promise.all(ixs));
  tx.sign(...signers);
  const bs58 = (await import('bs58')).default;
  const step = { market: m.id, action, signature: bs58.encode(tx.signature), status: 'pending' };
  evidence.steps.push(step); save();
  await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  for (let n = 0; n < 50; n++) {
    await new Promise(r => setTimeout(r, 1300));
    const s = (await conn.getSignatureStatuses([step.signature])).value[0];
    assert.equal(s?.err ?? null, null);
    if (['confirmed', 'finalized'].includes(s?.confirmationStatus)) { step.status = s.confirmationStatus; step.slot = s.slot; save(); console.log(m.symbol, action); return; }
  }
  throw Error(`Resolve pending transaction ${step.signature}`);
}
for (let i = 0; i < clients.length; i++) {
  const c = clients[i], m = registry.markets[i], owner = wallet.publicKey;
  await send(m, 'starter-assets', [
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: owner, lamports: 5000000 }),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, c.cash(owner).userCash, owner, new PublicKey(m.debtMint)),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, c.collateral(owner).userStock, owner, new PublicKey(m.collateralMint), TOKEN_2022_PROGRAM_ID),
    createMintToCheckedInstruction(new PublicKey(m.debtMint), c.cash(owner).userCash, admin.publicKey, 1000000000n, 6),
    createMintToCheckedInstruction(new PublicKey(m.collateralMint), c.collateral(owner).userStock, admin.publicKey, 2500000000n, 8, [], TOKEN_2022_PROGRAM_ID),
    c.initializePosition(owner),
  ], [admin, wallet]);
  // A balance from an unrelated mock stock must not become collateral here.
  if (i === 1) {
    const bad = await c.depositCollateral(owner, 100000000n);
    const own = c.collateral(owner).userStock;
    bad.keys = bad.keys.map(k => k.pubkey.equals(own) ? { ...k, pubkey: clients[0].collateral(owner).userStock } : k);
    const sim = await conn.simulateTransaction(new Transaction().add(bad), [wallet]);
    assert.ok(sim.value.err, 'Cross-market stock account must be rejected');
    evidence.assertions.push('MockSPYx account cannot collateralize MockNVDAx market (simulation rejected).'); save();
  }
  await send(m, 'deposit-8-borrow-500', [c.publish(BigInt(m.demoPrice) * 1000000n), c.depositCollateral(owner, 800000000n), c.borrow(owner, 500000000n)], [wallet, admin]);
  const position = await c.credit.account.position.fetch(positionAddress(c.market, owner));
  assert.equal(position.collateral.toString(), '800000000'); assert.ok(position.debtShares.gtn(0));
  for (let j = 0; j < clients.length; j++) if (j !== i) {
    const other = await clients[j].credit.account.position.fetchNullable(positionAddress(clients[j].market, owner));
    assert.ok(!other || (other.debtShares.isZero() && other.collateral.isZero()), 'Borrowing leaked into another market');
  }
  await send(m, 'repay-entire-loan', [c.repay(owner)]);
  await send(m, 'release-all-collateral', [c.withdrawCollateral(owner, 800000000n)]);
  await send(m, 'supply-100-demo-usd', [c.supply(owner, 100000000n)]);
  await send(m, 'redeem-all-supply', [c.redeem(owner)]);
  const final = await c.credit.account.position.fetch(positionAddress(c.market, owner));
  assert.ok(final.collateral.isZero() && final.debtShares.isZero() && final.supplyShares.isZero());
  assert.equal((await getAccount(conn, c.collateral(owner).userStock, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount, 2500000000n);
  evidence.assertions.push(`${m.symbol}: borrow isolated from other markets; repay, release and redemption returned collateral/debt/shares to zero; 25 stocks restored.`); save();
}
for (let n = 0; n < 40; n++) {
  const statuses = (await conn.getSignatureStatuses(evidence.steps.map(s => s.signature), { searchTransactionHistory: true })).value;
  statuses.forEach((s, i) => { assert.equal(s?.err ?? null, null); if (s) evidence.steps[i].status = s.confirmationStatus; }); save();
  if (statuses.every(s => s?.confirmationStatus === 'finalized')) { console.log('All 24 lifecycle transactions finalized.'); break; }
  if (n === 39) throw Error('Finalization still pending');
  await new Promise(r => setTimeout(r, 1500));
}
