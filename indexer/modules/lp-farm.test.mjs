import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SONATA_VAULT, VAULT_ADMIN } from "./common.mjs";
import { MAX_NFT_LOOKUPS, heldLiquidity, lpShares, lpWeights, nftHolder, runLpFarm } from "./lp-farm.mjs";
import { MAX_TX_BYTES } from "./payout.mjs";
import { dammPoolAccount, dbcAccounts, fakeChain, key, moduleContext, passContext, payoutLedger, pda, positionAccounts, rewardMarket, tokenAccount } from "./testkit.mjs";

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

test("a position earns the lesser of its liquidity now and at the previous pass", () => {
  const [kept, grown, shrunk, fresh] = [position(key(), 100n), position(key(), 500n), position(key(), 40n), position(key(), 900n)];
  const previous = new Map([[kept, 100n], [grown, 100n], [shrunk, 100n]].map(([p, v]) => [p.address.toBase58(), v]));
  assert.deepEqual(heldLiquidity([kept, grown, shrunk, fresh], previous).map((p) => p.unlocked), [100n, 100n, 40n, 0n]);
  // No previous pass: nothing has stayed a pass yet.
  assert.deepEqual(heldLiquidity([kept], null).map((p) => p.unlocked), [0n]);
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
// records no earlier pass.
async function farm({ migrated, positions = [], ataFor = [], owed = 1_000_000n, previous = (p) => p.unlocked ?? 0n }) {
  const authority = Keypair.generate();
  const chain = fakeChain();
  const m = rewardMarket(chain, authority.publicKey, { owed });
  const dbc = dbcAccounts(m, { migrated });
  chain.put(m.pool, dbc.poolInfo);
  chain.put(m.config, dbc.configInfo);
  const damm = dammPoolAccount(m, { migrationFeeOption: dbc.config.migrationFeeOption });
  if (migrated) chain.put(damm.address, damm.info);
  const accounts = [];
  for (const p of positions) {
    const acc = positionAccounts(damm.address, p);
    chain.put(acc.address, acc.info);
    if (acc.nft) chain.put(acc.nft.address, acc.nft.info);
    accounts.push(acc);
  }
  for (const w of ataFor) chain.put(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID), tokenAccount({ owner: w, mint: m.quoteMint }));
  const ledger = payoutLedger();
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
