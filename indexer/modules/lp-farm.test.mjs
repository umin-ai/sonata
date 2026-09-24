import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SONATA_VAULT, VAULT_ADMIN } from "./common.mjs";
import { MAX_NFT_LOOKUPS, POSITION_RELEASE_SECONDS, heldLiquidity, lpShares, lpWeights, nftHolder, observeLpFarm, runLpFarm } from "./lp-farm.mjs";
import { MAX_TX_BYTES, allocationOf } from "./payout.mjs";
import {
  BN, dammPoolAccount, dbcAccounts, editPosition, fakeChain, key, lpFarmLedger, moduleContext, passContext, pda, positionAccounts, rewardMarket, rewardsPass, tokenAccount,
} from "./testkit.mjs";

const position = (owner, unlocked, extra = {}) => ({ address: key(), nftMint: key(), owner, unlocked, ...extra });
const NOW = 1_900_000_000; // moduleContext's clock, in seconds
const PASS = 900;

test("LP weight is unlocked liquidity per NFT holder; locked positions, Sonata's keys and PDAs get nothing", () => {
  const [a, b, creator] = [key(), key(), key()];
  const crank = key();
  const positions = [
    // DBC's two graduation positions: permanently locked, no unlocked liquidity.
    position(creator, 0n, { permanent: 10n ** 20n }),
    position(SONATA_VAULT, 0n, { permanent: 10n ** 20n }),
    position(a, 300n),
    position(a, 100n), // summed per holder
    position(b, 200n),
    position(crank, 500n),
    position(VAULT_ADMIN, 500n),
    position(pda(), 500n),
  ];
  const w = lpWeights(positions, { excluded: [crank] });
  assert.deepEqual(w.lps.map((l) => [l.owner.toBase58(), l.balance]), [[a.toBase58(), 400n], [b.toBase58(), 200n]]);
  assert.equal(w.total, 600n);
  assert.deepEqual(lpShares(w, 1_000_000n).map((s) => s.amount), [666_666n, 333_333n]);
  // Nothing eligible: no LPs (the module then pays holders).
  assert.deepEqual(lpWeights([position(creator, 0n), position(SONATA_VAULT, 0n)]).lps, []);
});

test("a position whose NFT holder is unknown is allocated its share by position, not to the others", () => {
  const a = key();
  const unknown = position(null, 100n);
  const w = lpWeights([position(a, 100n), unknown]);
  assert.equal(w.total, 200n);
  const shares = lpShares(w, 1_000n);
  assert.deepEqual(shares.map((s) => [s.owner?.toBase58() ?? null, s.position?.toBase58() ?? null, s.amount]), [
    [a.toBase58(), null, 500n],
    [null, unknown.address.toBase58(), 500n],
  ]);
});

test("a position earns the lesser of its liquidity now and the least it held at the readings since the last round", () => {
  const [kept, grown, shrunk, fresh] = [position(key(), 100n), position(key(), 500n), position(key(), 40n), position(key(), 900n)];
  const previous = new Map([[kept, 100n], [grown, 100n], [shrunk, 100n]].map(([p, v]) => [p.address.toBase58(), v]));
  assert.deepEqual(heldLiquidity([kept, grown, shrunk, fresh], previous).map((p) => p.unlocked), [100n, 100n, 40n, 0n]);
  // No reading yet: nothing has stayed in place.
  assert.deepEqual(heldLiquidity([kept], null).map((p) => p.unlocked), [0n]);
  // Below the minimum a position is left out.
  assert.deepEqual(lpWeights([position(key(), 99n), position(key(), 100n)], { minLiquidity: 100n }).lps.map((l) => l.balance), [100n]);
});

test("the NFT holder is the owner of the Token-2022 account holding exactly one", () => {
  const owner = key(), mint = key(), address = key();
  assert.ok(nftHolder(address, tokenAccount({ owner, mint, amount: 1n }), mint).equals(owner));
  assert.equal(nftHolder(address, tokenAccount({ owner, mint, amount: 0n }), mint), null);
  assert.equal(nftHolder(address, tokenAccount({ owner, mint: key(), amount: 1n }), mint), null);
  assert.equal(nftHolder(address, null, mint), null);
});

// An LP Farm market. `previous(p, i)` is each position's unlocked liquidity at
// the pass before (recorded one pass ago; default: the same as now); null
// records no earlier pass. The DAMM v2 pool's liquidity is its positions'
// total (unlocked, locked and vesting) unless `liquidity` says otherwise.
async function farm({ migrated, positions = [], ataFor = [], owed = 1_000_000n, held = owed, previous = (p) => p.unlocked ?? 0n, liquidity }) {
  const authority = Keypair.generate();
  const chain = fakeChain();
  const m = rewardMarket(chain, authority.publicKey, { owed, held });
  const dbc = dbcAccounts(m, { migrated });
  chain.put(m.pool, dbc.poolInfo);
  chain.put(m.config, dbc.configInfo);
  const total = positions.reduce((s, p) => s + (p.unlocked ?? 0n) + (p.permanent ?? 0n) + (p.vested ?? 0n), 0n);
  const damm = dammPoolAccount(m, { migrationFeeOption: dbc.config.migrationFeeOption, liquidity: String(liquidity ?? total) });
  if (migrated) chain.put(damm.address, damm.info);
  const accounts = [];
  for (const p of positions) {
    const acc = positionAccounts(damm.address, p);
    chain.put(acc.address, acc.info);
    if (acc.nft) chain.put(acc.nft.address, acc.nft.info);
    accounts.push(acc);
  }
  for (const w of ataFor) chain.put(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID), tokenAccount({ owner: w, mint: m.quoteMint }));
  const ledger = lpFarmLedger(undefined, { clock: () => NOW });
  ledger.models.set(m.pool.toBase58(), { feeModel: "lpFarm" });
  if (previous)
    await ledger.recordSnapshot(m.pool.toBase58(), "lp", NOW - PASS, accounts.map((acc, i) => [acc.address.toBase58(), previous(positions[i], i)]).filter(([, v]) => v > 0n));
  const ctx = await moduleContext({ chain, m, authority, owed, ledger, model: { feeModel: "lpFarm" } });
  return { chain, m, ctx, ledger, damm, accounts, authority };
}
const quoteOf = (chain, m, w) => chain.balance(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID));

test("on the curve an LP farm pays holders, exactly as the holders module", async () => {
  const { ctx, ledger, m, chain } = await farm({ migrated: false });
  await runLpFarm(ctx);
  assert.deepEqual(ctx.heldBy, { module: "lpFarm", detail: { paidTo: "holders" } });
  assert.equal(ledger.statuses.get(m.pool.toBase58()), "holders");
  assert.ok(!chain.calls.some((c) => c.startsWith("getProgramAccounts")));
});

test("after graduation LPs are paid pro rata to unlocked liquidity; the locked graduation positions get nothing", async () => {
  const [a, b, creator, noAta] = [key(), key(), key(), key()];
  const { chain, m, ctx, ledger } = await farm({
    migrated: true,
    ataFor: [a, b, creator],
    positions: [
      { owner: creator, permanent: 10n ** 20n },
      { owner: SONATA_VAULT, permanent: 10n ** 20n },
      { owner: a, unlocked: 3n * 10n ** 18n },
      { owner: b, unlocked: 10n ** 18n },
      { owner: noAta, unlocked: 10n ** 18n },
    ],
  });
  assert.deepEqual(await runLpFarm(ctx), {});
  assert.equal(ctx.heldBy, undefined);
  assert.equal(ledger.statuses.get(m.pool.toBase58()), "lps");
  // 3:1:1 of 1000000; the LP without a quote account keeps its share, allocated to it.
  assert.deepEqual([a, b, noAta, creator].map((w) => quoteOf(chain, m, w)), [600_000n, 200_000n, null, 0n]);
  assert.equal(ctx.result.skipped.missing, 1);
  assert.deepEqual(ledger.allocationRows.filter((r) => r.status === "unpaid").map((r) => [r.recipient, r.amount]), [[noAta.toBase58(), 200_000n]]);
  assert.equal(ctx.fields.positions, 5);
  assert.equal(ctx.fields.lps, 3);
  assert.ok(chain.sent[0].bytes <= MAX_TX_BYTES);
  assert.deepEqual(ledger.payouts.map((r) => [r.module, r.amount, r.detail.paidTo]), [["lpFarm", 800_000n, "lps"]]);
  // This pass's positions are recorded for the next one.
  const recorded = ledger.snapshots.get(`${m.pool.toBase58()}|lp`).get(NOW);
  assert.deepEqual([...recorded.values()].sort(), [10n ** 18n, 10n ** 18n, 3n * 10n ** 18n].sort());
});

test("liquidity added just before a pass earns nothing that pass; each position earns what stayed since the previous pass", async () => {
  const [steady, jit, whale] = [key(), key(), key()];
  const { chain, m, ctx } = await farm({
    migrated: true,
    ataFor: [steady, jit, whale],
    positions: [
      { owner: steady, unlocked: 10n ** 18n },
      // Added just now: 10x everyone else, but absent at the previous pass.
      { owner: jit, unlocked: 10n ** 19n },
      // Topped up 9x since the previous pass: only what it had then counts.
      { owner: whale, unlocked: 9n * 10n ** 18n },
    ],
    previous: (p, i) => [10n ** 18n, 0n, 10n ** 18n][i],
  });
  await runLpFarm(ctx);
  assert.deepEqual([steady, jit, whale].map((w) => quoteOf(chain, m, w)), [500_000n, 0n, 500_000n]);
});

test("a graduated pool's first recorded pass pays no LP and no holder: its LPs earn from the next pass", async () => {
  const a = key();
  const { chain, m, ctx, ledger } = await farm({ migrated: true, ataFor: [a], positions: [{ owner: a, unlocked: 10n ** 18n }], previous: null });
  assert.deepEqual(await runLpFarm(ctx), {});
  assert.equal(ctx.heldBy, undefined);
  assert.equal(chain.sent.length, 0);
  assert.match(ctx.result.note, /first LP snapshot/);
  assert.equal(ledger.snapshots.get(`${m.pool.toBase58()}|lp`).size, 1);
});

test("a moved position NFT is found by its largest holder, and where it was found is cached", async () => {
  const [a, moved] = [key(), key()];
  const { chain, m, ctx, ledger, accounts } = await farm({ migrated: true, ataFor: [a, moved], positions: [{ owner: a, unlocked: 10n ** 18n }, { owner: moved, unlocked: 10n ** 18n, nftAccount: key() }] });
  await runLpFarm(ctx);
  assert.deepEqual([a, moved].map((w) => quoteOf(chain, m, w)), [500_000n, 500_000n]);
  assert.equal(chain.calls.filter((c) => c === "getTokenLargestAccounts").length, 1);
  assert.equal(ledger.nftCache.get(accounts[1].nftMint.toBase58()).owner, moved.toBase58());
});

test("moved NFTs beyond the per-pass lookup limit are found on later passes; their shares wait for them", async () => {
  const n = MAX_NFT_LOOKUPS + 5;
  const holders = Array.from({ length: n }, key);
  const { chain, m, ledger, authority } = await farm({
    migrated: true,
    ataFor: holders,
    owed: 25_000_000n,
    positions: holders.map((owner) => ({ owner, unlocked: 10n ** 18n, nftAccount: key() })),
  });
  const pass = async (at, distributed) => {
    ledger.clock = () => at;
    const ctx = await passContext({ chain, m, authority, distributed, ledger, model: { feeModel: "lpFarm" }, now: () => at * 1000 });
    await runLpFarm(ctx);
    return ctx;
  };
  const lookups = () => chain.calls.filter((c) => c === "getTokenLargestAccounts").length;
  const first = await pass(NOW, 25_000_000n);
  assert.equal(lookups(), MAX_NFT_LOOKUPS);
  assert.equal(first.fields.unknownNft, 5);
  // Every position gets 1000000; the five not found yet are allocated theirs by position.
  const paid = holders.map((w) => quoteOf(chain, m, w));
  assert.equal(paid.filter((v) => v === 1_000_000n).length, MAX_NFT_LOOKUPS);
  assert.equal(paid.filter((v) => v === 0n).length, 5);
  assert.deepEqual(ledger.allocationRows.filter((r) => r.kind === "position").map((r) => [r.status, r.amount]), Array(5).fill(["unpaid", 1_000_000n]));
  // Next pass: the cached twenty are not looked up again, the other five are, and are paid their own shares.
  await pass(NOW + PASS, 25_000_000n);
  assert.equal(lookups(), MAX_NFT_LOOKUPS + 5);
  assert.deepEqual(holders.map((w) => quoteOf(chain, m, w)), Array(n).fill(1_000_000n));
  assert.ok(ledger.allocationRows.every((r) => r.status === "paid"));
  // A third pass reads every holder from the cache.
  await pass(NOW + 2 * PASS, 25_000_000n);
  assert.equal(lookups(), MAX_NFT_LOOKUPS + 5);
});

test("after graduation with no eligible LP positions, holders are paid", async () => {
  const { ctx, ledger, m } = await farm({ migrated: true, positions: [{ owner: key(), permanent: 10n ** 20n }, { owner: SONATA_VAULT, permanent: 10n ** 20n }] });
  const r = await runLpFarm(ctx);
  assert.match(r.note, /no eligible LP positions; paid holders/);
  assert.deepEqual({ module: ctx.heldBy.module, detail: ctx.heldBy.detail }, { module: "lpFarm", detail: { paidTo: "holders" } });
  assert.equal(typeof ctx.heldBy.resolve, "function");
  assert.equal(ledger.statuses.get(m.pool.toBase58()), "holders");
});

// ---- Dust, part-time liquidity, position rows (review fixes) -------------------

// One lpFarm pass at unix seconds `at`, as payRewards runs it (ledger time `at` too).
const farmPass = ({ chain, m, ledger, authority }) => async (at, distributed) => {
  ledger.clock = () => at;
  const ctx = await passContext({ chain, m, authority, distributed, ledger, model: { feeModel: "lpFarm" }, now: () => at * 1000 });
  const outcome = await runLpFarm(ctx);
  return { ctx, outcome };
};
const observeAt = async ({ chain, m, ledger, authority }, at) => observeLpFarm(await moduleContext({ chain, m, authority, owed: 0n, ledger, model: { feeModel: "lpFarm" }, now: () => at * 1000 }));
const setUnlocked = (chain, address, unlocked, permanent) =>
  editPosition(chain, address, (s) => {
    s.unlockedLiquidity = new BN(unlocked.toString());
    if (permanent !== undefined) s.permanentLockedLiquidity = new BN(permanent.toString());
  });

test("a dust position beside the locked graduation positions earns nothing; LPs holding under 0.1% of the pool leave the round to holders", async () => {
  const [creator, attacker, lp] = [key(), key(), key()];
  const locked = [{ owner: creator, permanent: 10n ** 20n }, { owner: SONATA_VAULT, permanent: 10n ** 20n }];
  // Right after graduation: 1000 of unlocked liquidity is all the unlocked liquidity there is.
  const dust = await farm({ migrated: true, ataFor: [attacker], positions: [...locked, { owner: attacker, unlocked: 1000n }] });
  const d = await runLpFarm(dust.ctx);
  assert.equal(quoteOf(dust.chain, dust.m, attacker), 0n);
  assert.equal(dust.chain.sent.length, 0);
  assert.equal(dust.ledger.allocationRows.length, 0);
  assert.match(d.note, /no eligible LP positions; paid holders/);
  assert.deepEqual({ module: dust.ctx.heldBy.module, detail: dust.ctx.heldBy.detail }, { module: "lpFarm", detail: { paidTo: "holders" } });
  // 0.015% of the pool: above the 0.01% a position needs, but all eligible LPs together hold under 0.1%.
  const small = await farm({ migrated: true, ataFor: [attacker], positions: [...locked, { owner: attacker, unlocked: 3n * 10n ** 16n }] });
  const s = await runLpFarm(small.ctx);
  assert.equal(quoteOf(small.chain, small.m, attacker), 0n);
  assert.match(s.note, /eligible LP liquidity 30000000000000000 is below 0.1% of the pool's 200030000000000000000; paid holders/);
  assert.equal(small.ctx.heldBy.module, "lpFarm");
  // Beside a real LP (1% of the pool) the dust position still gets nothing.
  const real = await farm({ migrated: true, ataFor: [attacker, lp], positions: [...locked, { owner: attacker, unlocked: 1000n }, { owner: lp, unlocked: 2n * 10n ** 18n }] });
  await runLpFarm(real.ctx);
  assert.equal(real.ctx.heldBy, undefined);
  assert.deepEqual([attacker, lp].map((w) => quoteOf(real.chain, real.m, w)), [0n, 1_000_000n]);
  assert.equal(real.ctx.fields.lps, 1);
});

test("liquidity present at the payout readings but taken out at a reading in between earns nothing at the next payout", async () => {
  const [steady, jit] = [key(), key()];
  const run = await farm({ migrated: true, ataFor: [steady, jit], owed: 1_100_000n, held: 2_200_000n, positions: [{ owner: steady, unlocked: 10n ** 18n }, { owner: jit, unlocked: 10n ** 19n }] });
  const pass = farmPass(run);
  // Both stayed through the last pass: 1:10.
  await pass(NOW, 1_100_000n);
  assert.deepEqual([steady, jit].map((w) => quoteOf(run.chain, run.m, w)), [100_000n, 1_000_000n]);
  // jit takes its liquidity out after the payout and puts it back before the next pass;
  // a reading in between (a pass that pays nothing, or the one after the payouts) sees it gone.
  setUnlocked(run.chain, run.accounts[1].address, 0n);
  await observeAt(run, NOW + 300);
  setUnlocked(run.chain, run.accounts[1].address, 10n ** 19n);
  await observeAt(run, NOW + 600);
  const { ctx } = await pass(NOW + PASS, 2_200_000n);
  // The newest reading (NOW + 600) shows it back, but it was missing at NOW + 300: it earns 0.
  assert.deepEqual([steady, jit].map((w) => quoteOf(run.chain, run.m, w)), [1_200_000n, 1_000_000n]);
  assert.equal(ctx.fields.lps, 1);
  assert.deepEqual([...run.ledger.snapshots.get(`${run.m.pool.toBase58()}|lp`).keys()], [NOW - PASS, NOW, NOW + 300, NOW + 600, NOW + PASS]);
});

test("a pass that pays an LP Farm market reads its positions once more after every market has been paid", async () => {
  const lp = key();
  const run = await farm({ migrated: true, ataFor: [lp], positions: [{ owner: lp, unlocked: 10n ** 18n }] });
  let t = NOW * 1000;
  const { out } = await rewardsPass({ chain: run.chain, markets: [run.m], authority: run.authority, ledger: run.ledger, distributed: 1_000_000n, now: () => (t += 1000) });
  assert.equal(out.atoms, 1_000_000n);
  const series = run.ledger.snapshots.get(`${run.m.pool.toBase58()}|lp`);
  // The pass before, this pass's reading, and the one after the payout.
  assert.deepEqual([...series.keys()], [NOW - PASS, NOW + 1, NOW + 2]);
  assert.deepEqual([...series.get(NOW + 2).values()], [10n ** 18n]);
  // A dry run records nothing.
  await rewardsPass({ chain: run.chain, markets: [run.m], authority: run.authority, ledger: run.ledger, distributed: 2_000_000n, now: () => (t += 1000), dryRun: true });
  assert.equal(series.size, 3);
});

// 25 LP positions whose NFTs were moved: after the first pass the last five
// (by the lookup order) are position rows, allocated 1000000 each.
async function movedFarm() {
  const n = MAX_NFT_LOOKUPS + 5;
  const holders = Array.from({ length: n }, key);
  const run = await farm({ migrated: true, ataFor: holders, owed: 25_000_000n, positions: holders.map((owner) => ({ owner, unlocked: 10n ** 18n, nftAccount: key() })) });
  const pass = farmPass(run);
  await pass(NOW, 25_000_000n);
  const rows = run.ledger.allocationRows.filter((r) => r.kind === "position");
  assert.equal(rows.length, 5);
  const index = new Map(run.accounts.map((a, i) => [a.address.toBase58(), i]));
  const owed = rows.map((r) => index.get(r.recipient));
  return { ...run, holders, pass, owed };
}

test("a position row is paid to the NFT's holder even once its position has been emptied or its liquidity locked", async () => {
  const { chain, m, holders, accounts, pass, owed, ledger } = await movedFarm();
  // Before its holder was looked up, one position was emptied and another locked for good.
  setUnlocked(chain, accounts[owed[0]].address, 0n);
  setUnlocked(chain, accounts[owed[1]].address, 0n, 10n ** 18n);
  await pass(NOW + PASS, 25_000_000n);
  assert.deepEqual(holders.map((w) => quoteOf(chain, m, w)), Array(holders.length).fill(1_000_000n));
  assert.ok(ledger.allocationRows.every((r) => r.status === "paid"));
});

test("a closed position's row is paid to the last holder the crank saw", async () => {
  const { chain, m, holders, accounts, pass, owed, ledger } = await movedFarm();
  const i = owed[0], w = holders[i];
  const ata = getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID);
  const saved = chain.accounts.get(ata.toBase58());
  // Its holder is found next pass, but has no quote account then: the row waits.
  chain.accounts.delete(ata.toBase58());
  const { ctx } = await pass(NOW + PASS, 25_000_000n);
  assert.equal(ctx.result.skipped.missing, 1);
  assert.equal(ledger.positionOwners.get(accounts[i].address.toBase58())?.owner, w.toBase58());
  // Then the LP closes the position (its NFT is burned) and opens a quote account.
  editPosition(chain, accounts[i].address, () => null);
  chain.accounts.delete(accounts[i].nft.address.toBase58());
  chain.put(ata, saved);
  await pass(NOW + 2 * PASS, 25_000_000n);
  assert.equal(quoteOf(chain, m, w), 1_000_000n);
  assert.ok(ledger.allocationRows.every((r) => r.status === "paid"));
});

test("rows of a closed position whose holder was never found are released after 24 hours and owed to the market again", async () => {
  const steady = key();
  const run = await farm({ migrated: true, ataFor: [steady], owed: 700_000n, positions: [{ owner: steady, unlocked: 10n ** 18n }] });
  const pool = run.m.pool.toBase58();
  const pass = farmPass(run);
  // Allocated to a position while its holder was unknown; the position has been closed since.
  const closed = key();
  run.ledger.clock = () => NOW;
  await run.ledger.allocate(pool, { module: "lpFarm", shares: [allocationOf({ position: closed, amount: 700_000n, balance: 1n })] });
  const early = await pass(NOW + POSITION_RELEASE_SECONDS - 60, 700_000n);
  assert.equal(early.ctx.result.skipped.unresolved, 1);
  assert.equal(run.ledger.allocationRows.length, 1);
  assert.equal(quoteOf(run.chain, run.m, steady), 0n);
  const { ctx } = await pass(NOW + POSITION_RELEASE_SECONDS, 700_000n);
  assert.equal(ctx.fields.released, 700_000n);
  const line = ctx.lines.find((l) => l.action === "release");
  assert.deepEqual({ position: line.position, amount: line.amount, rounds: line.rounds }, { position: closed.toBase58(), amount: 700_000n, rounds: "1" });
  assert.match(line.reason, /closed and no holder of it was ever found/);
  // Back in what the market owes, it is a new round's: here the one LP's.
  assert.ok(!run.ledger.allocationRows.some((r) => r.recipient === closed.toBase58()));
  assert.equal(quoteOf(run.chain, run.m, steady), 700_000n);
  assert.equal(run.ledger.payouts.reduce((s, p) => s + p.amount, 0n), 700_000n);
});

test("an off-curve NFT holder's position rows are released after 24 hours; a wallet holder's never are", async () => {
  const [steady, wallet] = [key(), key()];
  const run = await farm({
    migrated: true, ataFor: [steady], owed: 700_000n,
    positions: [{ owner: steady, unlocked: 10n ** 18n }, { owner: pda("locker"), permanent: 10n ** 18n }, { owner: wallet, permanent: 10n ** 18n }],
  });
  const pool = run.m.pool.toBase58();
  const pass = farmPass(run);
  const [, offCurve, walletHeld] = run.accounts.map((a) => a.address);
  run.ledger.clock = () => NOW;
  await run.ledger.allocate(pool, { module: "lpFarm", shares: [allocationOf({ position: offCurve, amount: 300_000n, balance: 1n }), allocationOf({ position: walletHeld, amount: 400_000n, balance: 1n })] });
  const { ctx } = await pass(NOW + POSITION_RELEASE_SECONDS, 700_000n);
  assert.equal(ctx.fields.released, 300_000n);
  assert.match(ctx.lines.find((l) => l.action === "release").reason, /cannot be paid \(off curve or excluded\)/);
  assert.equal(ctx.result.skipped.missing, 1);
  assert.equal(quoteOf(run.chain, run.m, steady), 300_000n);
  // A day later the wallet still has no quote account: its row is still its own.
  await pass(NOW + 2 * POSITION_RELEASE_SECONDS, 700_000n);
  assert.deepEqual(run.ledger.allocationRows.filter((r) => r.status === "unpaid").map((r) => [r.recipient, r.amount]), [[walletHeld.toBase58(), 400_000n]]);
  quoteAccountOf(run, wallet);
  await pass(NOW + 2 * POSITION_RELEASE_SECONDS + PASS, 700_000n);
  assert.equal(quoteOf(run.chain, run.m, wallet), 400_000n);
  assert.equal(quoteOf(run.chain, run.m, steady), 300_000n);
});
const quoteAccountOf = ({ chain, m }, w) => chain.put(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID), tokenAccount({ owner: w, mint: m.quoteMint }));
