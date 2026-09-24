import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SONATA_VAULT, VAULT_ADMIN } from "./common.mjs";
import { lpShares, lpWeights, nftHolder, runLpFarm } from "./lp-farm.mjs";
import { MAX_TX_BYTES } from "./payout.mjs";
import { dammPoolAccount, dbcAccounts, fakeChain, key, memLedger, moduleContext, pda, positionAccounts, rewardMarket, tokenAccount } from "./testkit.mjs";

const position = (owner, unlocked, extra = {}) => ({ address: key(), nftMint: key(), owner, unlocked, ...extra });

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

test("a position whose NFT holder is unknown keeps its share owed instead of passing it to the others", () => {
  const a = key();
  const w = lpWeights([position(a, 100n), position(null, 100n)]);
  assert.equal(w.total, 200n);
  assert.deepEqual(lpShares(w, 1_000n).map((s) => [s.owner.toBase58(), s.amount]), [[a.toBase58(), 500n]]);
});

test("the NFT holder is the owner of the Token-2022 account holding exactly one", () => {
  const owner = key(), mint = key(), address = key();
  assert.ok(nftHolder(address, tokenAccount({ owner, mint, amount: 1n }), mint).equals(owner));
  assert.equal(nftHolder(address, tokenAccount({ owner, mint, amount: 0n }), mint), null);
  assert.equal(nftHolder(address, tokenAccount({ owner, mint: key(), amount: 1n }), mint), null);
  assert.equal(nftHolder(address, null, mint), null);
});

async function farm({ migrated, positions = [], ataFor = [], owed = 1_000_000n }) {
  const authority = Keypair.generate();
  const chain = fakeChain();
  const m = rewardMarket(chain, authority.publicKey, { owed });
  const dbc = dbcAccounts(m, { migrated });
  chain.put(m.pool, dbc.poolInfo);
  chain.put(m.config, dbc.configInfo);
  const damm = dammPoolAccount(m, { migrationFeeOption: dbc.config.migrationFeeOption });
  if (migrated) chain.put(damm.address, damm.info);
  for (const p of positions) {
    const acc = positionAccounts(damm.address, p);
    chain.put(acc.address, acc.info);
    if (acc.nft) chain.put(acc.nft.address, acc.nft.info);
  }
  for (const w of ataFor) chain.put(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID), tokenAccount({ owner: w, mint: m.quoteMint }));
  const ledger = memLedger();
  ledger.models.set(m.pool.toBase58(), { feeModel: "lpFarm" });
  const ctx = await moduleContext({ chain, m, authority, owed, ledger, model: { feeModel: "lpFarm" } });
  return { chain, m, ctx, ledger, damm };
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
  // 3:1:1 of 1000000; the LP without a quote account keeps its share owed.
  assert.deepEqual([a, b, noAta, creator].map((w) => quoteOf(chain, m, w)), [600_000n, 200_000n, null, 0n]);
  assert.equal(ctx.result.skipped.missing, 1);
  assert.equal(ctx.fields.positions, 5);
  assert.equal(ctx.fields.lps, 3);
  assert.ok(chain.sent[0].bytes <= MAX_TX_BYTES);
  assert.deepEqual(ledger.payouts.map((r) => [r.module, r.amount, r.detail.paidTo]), [["lpFarm", 800_000n, "lps"]]);
});

test("a moved position NFT is found by its largest holder", async () => {
  const [a, moved] = [key(), key()];
  const { chain, m, ctx } = await farm({ migrated: true, ataFor: [a, moved], positions: [{ owner: a, unlocked: 10n ** 18n }, { owner: moved, unlocked: 10n ** 18n, nftAccount: key() }] });
  await runLpFarm(ctx);
  assert.deepEqual([a, moved].map((w) => quoteOf(chain, m, w)), [500_000n, 500_000n]);
  assert.equal(chain.calls.filter((c) => c === "getTokenLargestAccounts").length, 1);
});

test("after graduation with no eligible LP positions, holders are paid", async () => {
  const { ctx, ledger, m } = await farm({ migrated: true, positions: [{ owner: key(), permanent: 10n ** 20n }, { owner: SONATA_VAULT, permanent: 10n ** 20n }] });
  const r = await runLpFarm(ctx);
  assert.match(r.note, /no eligible LP positions; paid holders/);
  assert.deepEqual(ctx.heldBy, { module: "lpFarm", detail: { paidTo: "holders" } });
  assert.equal(ledger.statuses.get(m.pool.toBase58()), "holders");
});
