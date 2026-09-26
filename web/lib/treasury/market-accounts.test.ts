// The batched market readers (runtime.ts: readMarketsAndCards, discoverMarkets,
// cardsFromAccounts, marketFromIdentity) against four real Devnet markets
// captured in fixtures/devnet-markets.json. The "golden" answers there were
// recorded from discoverMarkets and readTreasury as they were before the
// batched readers existed, so these tests compare against the old code's own
// output rather than against the new code.
import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { deriveDammV2PoolAddress, deriveMintMetadata, DAMM_V2_MIGRATION_FEE_ADDRESS } from "@meteora-ag/dynamic-bonding-curve-sdk";
import fixtureJson from "./fixtures/devnet-markets.json" with { type: "json" };
import dbcIdl from "./dbc.json" with { type: "json" };
import { browserAnchor } from "./anchor.mjs";
import { fakeConnection, type Call, type Fixture, type RawAccount } from "./fixtures/fake-rpc.ts";
import {
  accountBatches,
  cardsFromAccounts,
  checkNetwork,
  dammV2PoolAddress,
  discoverMarkets,
  identityOf,
  marketFromIdentity,
  metadataAddress,
  readMarketsAndCards,
  readTreasury,
  treasuryEntries,
  MAX_ACCOUNTS_PER_CALL,
  type Market,
  type MarketIdentity,
} from "./runtime.ts";

const fixture = fixtureJson as unknown as Fixture;
const golden = fixture.golden as { markets: Market[]; treasuries: Record<string, Record<string, unknown>> };
const { BorshAccountsCoder } = browserAnchor as typeof import("@coral-xyz/anchor");
const dbcCoder = new BorshAccountsCoder(dbcIdl as never);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const bytes = (a: RawAccount) => Buffer.from(a.data[0], "base64");
const withBytes = (a: RawAccount, data: Buffer): RawAccount => ({ ...a, data: [data.toString("base64"), "base64"] });
// Card numbers compared without the read time; a graduated market's pool fees are not part of a card.
const without = (s: Record<string, unknown>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(s).filter(([k]) => !keys.includes(k)));
const comparable = (s: Record<string, unknown>) =>
  without(s, "fetchedAt", "poolFees", ...(s.migrated ? ["uncollected"] : []));
const byPool = (pool: string) => golden.markets.find((m) => m.pool === pool)!;
// A registered quote mint other than the market's own.
const otherQuoteOf = (m: MarketIdentity) =>
  ["6gat24puM23p74CeBKEPs53roxqpHcQpiGL8ZHtgNJqg", "dXrPEzAYgn5H3y7GwCfCr6okHsWXidpMQrRq33LNTJh"].find((q) => q !== m.quoteMint)!;
const room = golden.markets.find((m) => m.symbol === "ROOM")!;
const floorMarket = golden.markets.find((m) => m.mode === "floor")!;

test("the fixture has the four kinds of market the tests rely on", () => {
  assert.deepEqual(
    golden.markets.map((m) => m.mode),
    ["duet", "floor", "standard", "standardFloor"],
  );
  assert.equal(golden.treasuries[room.pool].migrated, true, "ROOM has graduated");
});

test("discoverMarkets lists the same markets as before, in two calls after the network check", async () => {
  const calls: Call[] = [];
  const markets = await discoverMarkets(fakeConnection(fixture, { calls }));
  assert.deepEqual(clone(markets), golden.markets);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["getGenesisHash", "getProgramAccounts", "getMultipleAccounts"],
  );
});

test("readMarketsAndCards lists the same markets, with readTreasury's numbers for each card", async () => {
  const { cards, skipped, slot } = await readMarketsAndCards(fakeConnection(fixture));
  assert.deepEqual(skipped, []);
  assert.equal(slot, fixture.slot);
  assert.deepEqual(clone(cards.map((c) => c.market)), golden.markets);
  for (const card of cards) {
    assert.ok(card.data, `${card.market.symbol}: ${card.error}`);
    assert.deepEqual(comparable(clone(card.data)), comparable(golden.treasuries[card.market.pool]), card.market.symbol);
    assert.equal(card.data.poolFees, null);
  }
});

test("readTreasury answers as before, graduated pool fees included", async () => {
  const conn = fakeConnection(fixture);
  for (const market of golden.markets) {
    const now = without(clone(await readTreasury(market, conn)), "fetchedAt");
    assert.deepEqual(now, without(golden.treasuries[market.pool], "fetchedAt"), market.symbol);
  }
});

test("cards from accounts read elsewhere (the server snapshot) match the browser's own read", async () => {
  const info = (key: string) => {
    if (!Object.hasOwn(fixture.accounts, key)) throw Error(`not read: ${key}`);
    const a = fixture.accounts[key];
    return a && { ...a, owner: new PublicKey(a.owner), data: bytes(a) };
  };
  const { entries, skipped } = treasuryEntries(
    fixture.programAccounts.map((p) => p.pubkey),
    info,
  );
  assert.deepEqual(skipped, []);
  const fromSnapshot = cardsFromAccounts(entries, info, () => fixture.slot);
  const live = await readMarketsAndCards(fakeConnection(fixture));
  assert.deepEqual(clone(fromSnapshot.cards.map((c) => c.market)), clone(live.cards.map((c) => c.market)));
  assert.deepEqual(
    fromSnapshot.cards.map((c) => comparable(clone(c.data!))),
    live.cards.map((c) => comparable(clone(c.data!))),
  );
  // An account the snapshot does not hold fails that market, never the list.
  const partial = cardsFromAccounts(entries, (key) => (key === floorMarket.treasuryQuote ? info("missing") : info(key)), () => 1);
  assert.equal(partial.cards.length, 4);
  assert.equal(partial.cards.find((c) => c.market.pool === floorMarket.pool)?.data, null);
  assert.match(partial.cards.find((c) => c.market.pool === floorMarket.pool)?.error ?? "", /not read/);
});

// ---- The listing rule and the card checks reject what they must -----------------

// Finds a u8 field's offset by trying each byte (the anchor coder cannot
// re-encode accounts over 1000 bytes), then sets it.
function setConfigByte(data: Buffer, field: string, value: number) {
  const before = dbcCoder.decode("poolConfig", data) as Record<string, unknown>;
  for (let i = 8; i < data.length; i++) {
    if (data[i] !== before[field]) continue;
    const copy = Buffer.from(data);
    copy[i] = value;
    try {
      const after = dbcCoder.decode("poolConfig", copy) as Record<string, unknown>;
      if (after[field] === value) return copy;
    } catch {
      /* not this byte */
    }
  }
  throw Error(`no byte for ${field}`);
}

test("a market whose Meteora config is not the standard launch is not listed", async () => {
  const accounts = clone(fixture.accounts);
  const config = accounts[floorMarket.config]!;
  accounts[floorMarket.config] = withBytes(config, setConfigByte(bytes(config), "creatorTradingFeePercentage", 50));
  const { cards, skipped } = await readMarketsAndCards(fakeConnection(fixture, { accounts }));
  assert.deepEqual(cards.map((c) => c.market.pool), golden.markets.filter((m) => m !== floorMarket).map((m) => m.pool));
  assert.deepEqual(skipped, []);
  assert.deepEqual((await discoverMarkets(fakeConnection(fixture, { accounts }))).map((m) => m.pool), cards.map((c) => c.market.pool));
});

test("a registered pool that is not a DBC pool is skipped and reported, and the rest are listed", async () => {
  const accounts = clone(fixture.accounts);
  accounts[floorMarket.pool] = { ...accounts[floorMarket.pool]!, owner: "11111111111111111111111111111111" };
  const { cards, skipped } = await readMarketsAndCards(fakeConnection(fixture, { accounts }));
  assert.equal(cards.length, 3);
  assert.deepEqual(skipped, [{ pool: floorMarket.pool, reason: "A registered pool could not be verified." }]);
  assert.equal((await discoverMarkets(fakeConnection(fixture, { accounts }))).length, 3);
});

test("when no registered pool can be verified, discoverMarkets reports it instead of an empty list", async () => {
  const accounts = clone(fixture.accounts);
  for (const m of golden.markets) accounts[m.pool] = { ...accounts[m.pool]!, owner: "11111111111111111111111111111111" };
  await assert.rejects(discoverMarkets(fakeConnection(fixture, { accounts })), /could not be verified/);
});

test("treasuries on an unregistered quote mint or in an unknown mode are not considered", async () => {
  const programAccounts = clone(fixture.programAccounts);
  const quote = bytes(programAccounts[1].account);
  new PublicKey("So11111111111111111111111111111111111111112").toBuffer().copy(quote, 72);
  programAccounts[1].account = withBytes(programAccounts[1].account, quote);
  const mode = bytes(programAccounts[2].account);
  mode[200] = 2; // Sustain: the program has it, the app never launches it.
  programAccounts[2].account = withBytes(programAccounts[2].account, mode);
  const { cards } = await readMarketsAndCards(fakeConnection(fixture, { programAccounts }));
  assert.deepEqual(cards.map((c) => c.market.symbol), ["ROOM", "BACKED"]);
});

test("a card whose custody or accounting fails its checks is listed with no numbers and the reason", async () => {
  const cases: [string, (token: Buffer) => void, RegExp][] = [
    ["frozen custody", (t) => void (t[108] = 2), /custody verification/],
    ["custody owned by someone else", (t) => void new PublicKey(room.creator).toBuffer().copy(t, 32), /custody verification/],
    ["custody short of the accounting", (t) => void t.fill(0, 64, 72), /does not reconcile/],
  ];
  for (const [label, change, reason] of cases) {
    const accounts = clone(fixture.accounts);
    const custody = bytes(accounts[room.treasuryQuote]!);
    change(custody);
    accounts[room.treasuryQuote] = withBytes(accounts[room.treasuryQuote]!, custody);
    const { cards } = await readMarketsAndCards(fakeConnection(fixture, { accounts }));
    const card = cards.find((c) => c.market.pool === room.pool)!;
    assert.equal(card.data, null, label);
    assert.match(card.error ?? "", reason, label);
    assert.equal(cards.filter((c) => c.data).length, 3, `${label}: the other cards keep their numbers`);
    await assert.rejects(readTreasury(room, fakeConnection(fixture, { accounts })), reason, `${label}: readTreasury agrees`);
  }
});

// ---- Addresses derived without the SDK ------------------------------------------

test("metadata and graduated pool addresses match the DBC SDK's derivations", () => {
  for (const m of golden.markets) {
    assert.equal(metadataAddress(m.baseMint).toBase58(), deriveMintMetadata(new PublicKey(m.baseMint)).toBase58());
    for (let option = 0; option < DAMM_V2_MIGRATION_FEE_ADDRESS.length; option++)
      for (const [a, b] of [
        [m.baseMint, m.quoteMint],
        [m.quoteMint, m.baseMint],
      ])
        assert.equal(
          dammV2PoolAddress(option, a, b),
          deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[option], new PublicKey(a), new PublicKey(b)).toBase58(),
        );
  }
  assert.equal(dammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS.length, room.baseMint, room.quoteMint), null);
  assert.equal(golden.treasuries[room.pool].dammPool, dammV2PoolAddress(2, room.baseMint, room.quoteMint));
});

// ---- Batching --------------------------------------------------------------------

test("reads are batched: at most 100 accounts a call, shared keys first, no market split across calls", () => {
  const key = (i: number, j: number) => `m${i}k${j}`;
  for (const count of [1, 4, 13, 19, 30, 100]) {
    const groups = Array.from({ length: count }, (_, i) => Array.from({ length: 7 }, (_, j) => key(i, j)));
    const shared = ["mintA", "mintB", "program"];
    const batches = accountBatches(groups, shared);
    assert.ok(batches.every((b) => b.length <= MAX_ACCOUNTS_PER_CALL), `${count}: call size`);
    assert.deepEqual(batches[0].slice(0, 3), shared);
    for (const g of groups) assert.equal(new Set(g.map((k) => batches.findIndex((b) => b.includes(k)))).size, 1, `${count}: ${g[0]} split`);
    assert.equal(batches.flat().length, count * 7 + 3, `${count}: every key once`);
    // Whole groups only: the first call fits the 3 shared keys and 13 groups (94), later calls 14 groups (98).
    assert.equal(batches.length, count <= 13 ? 1 : 1 + Math.ceil((count - 13) / 14), `${count}: calls`);
  }
  // 19 markets (the Devnet list today): 136 keys in 2 calls.
  assert.equal(accountBatches(Array.from({ length: 19 }, (_, i) => Array.from({ length: 7 }, (_, j) => key(i, j))), ["q", "p"]).length, 2);
  // A key two groups share is read once, in the first call that needs it.
  const shared = accountBatches([["a", "payout"], ["b", "payout"]]);
  assert.deepEqual(shared, [["a", "payout", "b"]]);
});

test("the card read makes one getProgramAccounts and one getMultipleAccounts per 100 accounts", async () => {
  const calls: Call[] = [];
  await readMarketsAndCards(fakeConnection(fixture, { calls }));
  assert.deepEqual(
    calls.map((c) => c.method),
    ["getGenesisHash", "getProgramAccounts", "getMultipleAccounts"],
  );
  // 4 markets × 7 accounts, the quote mint and the program.
  assert.equal(calls[2].keys, Object.keys(fixture.accounts).length);
  assert.ok(calls[2].keys! <= MAX_ACCOUNTS_PER_CALL);
});

test("the network check runs once a minute per connection", async () => {
  const calls: Call[] = [];
  const conn = fakeConnection(fixture, { calls });
  await checkNetwork(conn);
  await checkNetwork(conn);
  assert.equal(calls.length, 1);
  await checkNetwork(conn, -1);
  assert.equal(calls.length, 2);
  const bad = fakeConnection({ ...fixture, genesis: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY" });
  await assert.rejects(checkNetwork(bad), /Devnet verification failed/);
});

// ---- Identity received from the server -------------------------------------------

test("a market rebuilt from its identity is the market discoverMarkets lists", () => {
  for (const m of golden.markets) assert.deepEqual(clone(marketFromIdentity(identityOf(m))), m, m.symbol);
});

test("fields beyond the identity are never taken from the input", () => {
  const input = {
    ...identityOf(floorMarket),
    programId: "11111111111111111111111111111111",
    vault: "11111111111111111111111111111111",
    quoteDecimals: 2,
    baseDecimals: 0,
    traces: [{ label: "fake", signature: "x" }],
    network: "mainnet",
  } as MarketIdentity;
  assert.deepEqual(clone(marketFromIdentity(input)), floorMarket);
});

test("an identity whose derived addresses do not match is refused", () => {
  const other = "So11111111111111111111111111111111111111112";
  const cases: [string, Partial<MarketIdentity>][] = [
    ["treasury quote account", { treasuryQuote: other }],
    ["treasury base account", { treasuryBase: other }],
    ["payout quote account", { payoutQuote: other }],
    ["treasury address", { treasury: other }],
    ["quote mint (derived accounts left as they were)", { quoteMint: otherQuoteOf(floorMarket) }],
    ["unregistered quote mint", { quoteMint: other }],
    ["not an address", { config: "not-a-key" }],
    ["mode", { mode: "sustain" as Market["mode"] }],
    ["profile location", { uri: "https://example.com/token.json" }],
  ];
  for (const [label, change] of cases)
    assert.throws(() => marketFromIdentity({ ...identityOf(floorMarket), ...change }), Error, label);
});

test("a tampered identity whose derived accounts are made to match still fails readTreasury's binding check", async () => {
  const ata = (mint: string, owner: string) =>
    getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, TOKEN_2022_PROGRAM_ID).toBase58();
  const baseAta = (mint: string, owner: string) =>
    getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true).toBase58();
  const somebody = "7etAC9hGUddET4o7jCCQ3YHgf9QptAqoqoqiQQTT7wRi";
  for (const target of [floorMarket, byPool(golden.markets[3].pool)]) {
    const id = identityOf(target);
    const otherQuote = otherQuoteOf(id);
    const cases: [string, MarketIdentity, Record<string, string>][] = [
      // Each case: the tampered identity, and fixture accounts copied to any new addresses it reads.
      ["config", { ...id, config: somebody }, { [somebody]: id.config }],
      [
        "baseMint",
        { ...id, baseMint: somebody, treasuryBase: baseAta(somebody, id.treasury) },
        { [somebody]: id.baseMint },
      ],
      [
        "quoteMint",
        { ...id, quoteMint: otherQuote, treasuryQuote: ata(otherQuote, id.treasury), payoutQuote: ata(otherQuote, id.payoutOwner) },
        { [otherQuote]: id.quoteMint, [ata(otherQuote, id.treasury)]: id.treasuryQuote, [ata(otherQuote, id.payoutOwner)]: id.payoutQuote },
      ],
      ["creator", { ...id, creator: somebody }, {}],
      [
        "payoutOwner",
        { ...id, payoutOwner: somebody, payoutQuote: ata(id.quoteMint, somebody) },
        { [ata(id.quoteMint, somebody)]: id.payoutQuote },
      ],
      ["mode", { ...id, mode: id.mode === "floor" ? "duet" : "floor" }, {}],
      ["baseVault", { ...id, baseVault: somebody }, {}],
      ["quoteVault", { ...id, quoteVault: somebody }, {}],
    ];
    for (const [label, tampered, copies] of cases) {
      const market = marketFromIdentity(tampered); // passes: only chain state can catch these
      const accounts = clone(fixture.accounts);
      for (const [to, from] of Object.entries(copies)) accounts[to] = accounts[from];
      await assert.rejects(
        readTreasury(market, fakeConnection(fixture, { accounts })),
        /changed|does not match|verification failed/,
        `${target.symbol} ${label}`,
      );
    }
  }
});
