// The batched market readers (runtime.ts: readMarketsAndCards, discoverMarkets,
// cardsFromAccounts, marketFromIdentity) against four real Devnet markets
// captured in fixtures/devnet-markets.json. The "golden" answers there were
// recorded from discoverMarkets and readTreasury as they were before the
// batched readers existed, so these tests compare against the old code's own
// output rather than against the new code.
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { deriveDammV2PoolAddress, deriveMintMetadata, DAMM_V2_MIGRATION_FEE_ADDRESS } from "@meteora-ag/dynamic-bonding-curve-sdk";
import fixtureJson from "./fixtures/devnet-markets.json" with { type: "json" };
import { fakeConnection, type Call, type Fixture, type RawAccount } from "./fixtures/fake-rpc.ts";
import { setConfigByte } from "./fixtures/config-bytes.ts";
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
  readTreasuryVerified,
  readWalletBalances,
  treasuryEntries,
  withPoolFees,
  MAX_ACCOUNTS_PER_CALL,
  type Market,
  type MarketIdentity,
} from "./runtime.ts";

const fixture = fixtureJson as unknown as Fixture;
const golden = fixture.golden as { markets: Market[]; treasuries: Record<string, Record<string, unknown>> };

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

test("a market whose Meteora config is not the standard launch is not listed", async () => {
  const accounts = clone(fixture.accounts);
  const config = accounts[floorMarket.config]!;
  accounts[floorMarket.config] = withBytes(config, setConfigByte(bytes(config), "creatorTradingFeePercentage", 50));
  const { cards, skipped } = await readMarketsAndCards(fakeConnection(fixture, { accounts }));
  assert.deepEqual(cards.map((c) => c.market.pool), golden.markets.filter((m) => m !== floorMarket).map((m) => m.pool));
  assert.deepEqual(skipped, []);
  assert.deepEqual((await discoverMarkets(fakeConnection(fixture, { accounts }))).map((m) => m.pool), cards.map((c) => c.market.pool));
});

test("a config not owned by the DBC program is not listed, even with standard bytes", async () => {
  const accounts = clone(fixture.accounts);
  accounts[floorMarket.config] = { ...accounts[floorMarket.config]!, owner: "11111111111111111111111111111111" };
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

test("with 10 accounts a call, the same markets and numbers in 4 calls, each card at its own call's slot", async () => {
  const calls: Call[] = [];
  const slots = [201, 202, 203, 204];
  const { cards, skipped, slot } = await readMarketsAndCards(fakeConnection(fixture, { calls, slots }), { maxPerCall: 10 });
  const multiple = calls.filter((c) => c.method === "getMultipleAccounts");
  assert.equal(multiple.length, 4);
  assert.ok(multiple.every((c) => c.keys! <= 10));
  assert.deepEqual(skipped, []);
  assert.equal(slot, 201, "the lowest slot");
  assert.deepEqual(clone(cards.map((c) => c.market)), golden.markets);
  // The 3 shared keys and the first market fill the first call; each later market has a call of its own.
  cards.forEach((card, i) => {
    assert.ok(card.data, `${card.market.symbol}: ${card.error}`);
    assert.equal(card.data.slot, slots[i], card.market.symbol);
    assert.deepEqual(without(comparable(clone(card.data)), "slot"), without(comparable(golden.treasuries[card.market.pool]), "slot"));
  });
  const listed = await discoverMarkets(fakeConnection(fixture, { calls: [] }), { maxPerCall: 5 });
  assert.deepEqual(clone(listed), golden.markets);
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

// ---- Graduated pool fees ----------------------------------------------------------

test("withPoolFees adds a graduated market's pool fees and replaces its curve's uncollected fees", async () => {
  const conn = fakeConnection(fixture);
  const state = await readTreasuryVerified(room, conn);
  assert.ok(state.migrated && state.dammPool);
  const asked: string[] = [];
  const fees = {
    dammPool: state.dammPool,
    position: "p",
    positionNftAccount: "n",
    tokenAVault: "a",
    tokenBVault: "b",
    quote: "123456",
    base: "0",
  };
  const read = async (m: Market, pool: string) => (asked.push(`${m.symbol}:${pool}`), fees);
  const full = await withPoolFees(room, state, conn, read);
  assert.deepEqual(asked, [`ROOM:${state.dammPool}`]);
  assert.equal(full.uncollected, "123456");
  assert.deepEqual(full.poolFees, fees);
  assert.deepEqual(without(full, "uncollected", "poolFees"), without(state, "uncollected", "poolFees"));
  // Unreadable fees: the reason, and the curve's number is not replaced by a guess.
  const failed = await withPoolFees(room, state, conn, async () => {
    throw Error("pool not found");
  });
  assert.deepEqual(failed.poolFees, { error: "pool not found" });
  assert.equal(failed.uncollected, state.uncollected);
  // A market on its curve reads no pool fees.
  const curve = await readTreasuryVerified(floorMarket, conn);
  const onCurve = await withPoolFees(floorMarket, curve, conn, async () => {
    throw Error("must not be read");
  });
  assert.equal(onCurve.poolFees, null);
  assert.equal(onCurve.uncollected, curve.uncollected);
});

// ---- Wallet balances (the portfolio) -----------------------------------------------

// A wallet is a key on the curve (the other tests' "somebody" is a PDA).
const wallet = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();
function tokenAccount(mint: string, owner: string, amount: bigint, program: PublicKey, state = AccountState.Initialized): RawAccount {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint: new PublicKey(mint),
      owner: new PublicKey(owner),
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return { data: [data.toString("base64"), "base64"], executable: false, lamports: 2_039_280, owner: program.toBase58(), rentEpoch: 0 };
}
const quoteAta = (mint: string, owner = wallet) =>
  getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, TOKEN_2022_PROGRAM_ID).toBase58();
const baseAta = (mint: string, owner = wallet) =>
  getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, TOKEN_PROGRAM_ID).toBase58();
// The wallet holds ROOM's quote stock and ROOM tokens; it has never touched the other markets' tokens.
function walletAccounts(change: (a: Record<string, RawAccount | null>) => void = () => {}) {
  const accounts: Record<string, RawAccount | null> = clone(fixture.accounts);
  accounts[wallet] = { data: ["", "base64"], executable: false, lamports: 1_500_000_000, owner: "11111111111111111111111111111111", rentEpoch: 0 };
  for (const m of golden.markets) {
    accounts[quoteAta(m.quoteMint)] = null;
    accounts[baseAta(m.baseMint)] = null;
  }
  accounts[quoteAta(room.quoteMint)] = tokenAccount(room.quoteMint, wallet, 700n, TOKEN_2022_PROGRAM_ID);
  accounts[baseAta(room.baseMint)] = tokenAccount(room.baseMint, wallet, 42n, TOKEN_PROGRAM_ID);
  change(accounts);
  return accounts;
}

test("readWalletBalances reads every market's balances in one batched read, with readTradingWallet's shape", async () => {
  const calls: Call[] = [];
  const balances = await readWalletBalances(wallet, golden.markets, fakeConnection(fixture, { calls, accounts: walletAccounts() }));
  assert.deepEqual(
    calls.map((c) => c.method),
    ["getGenesisHash", "getMultipleAccounts"],
  );
  assert.deepEqual([...balances.keys()], golden.markets.map((m) => m.pool));
  for (const m of golden.markets) {
    const b = balances.get(m.pool)!;
    const sameQuote = m.quoteMint === room.quoteMint;
    assert.deepEqual(
      b,
      {
        wallet,
        slot: fixture.slot,
        sol: "1500000000",
        quote: sameQuote ? "700" : "0",
        base: m === room ? "42" : "0",
        hasBase: m === room,
        hasQuote: sameQuote,
      },
      m.symbol,
    );
  }
  // Split across calls when asked to: the same answer.
  const small: Call[] = [];
  const again = await readWalletBalances(wallet, golden.markets, fakeConnection(fixture, { calls: small, accounts: walletAccounts() }), {
    maxPerCall: 2,
  });
  const keys = 1 + new Set(golden.markets.map((m) => m.quoteMint)).size + golden.markets.length;
  assert.equal(small.filter((c) => c.method === "getMultipleAccounts").length, Math.ceil(keys / 2));
  assert.deepEqual([...again.values()].map((b) => ({ ...b, slot: 0 })), [...balances.values()].map((b) => ({ ...b, slot: 0 })));
});

test("readWalletBalances refuses a frozen token account, or one for another mint or owner", async () => {
  const cases: [string, (a: Record<string, RawAccount | null>) => void][] = [
    ["frozen", (a) => void (a[baseAta(room.baseMint)] = tokenAccount(room.baseMint, wallet, 42n, TOKEN_PROGRAM_ID, AccountState.Frozen))],
    ["another mint", (a) => void (a[baseAta(room.baseMint)] = tokenAccount(floorMarket.baseMint, wallet, 42n, TOKEN_PROGRAM_ID))],
    ["another owner", (a) => void (a[quoteAta(room.quoteMint)] = tokenAccount(room.quoteMint, room.creator, 700n, TOKEN_2022_PROGRAM_ID))],
  ];
  for (const [label, change] of cases)
    await assert.rejects(
      readWalletBalances(wallet, golden.markets, fakeConnection(fixture, { accounts: walletAccounts(change) })),
      /Unexpected wallet token account/,
      label,
    );
});

// ---- The network check ----------------------------------------------------------------

test("a read made together with the network check is never used when the check fails", async () => {
  const mainnet = { ...fixture, genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" };
  await assert.rejects(readTreasury(room, fakeConnection(mainnet)), /Devnet verification failed/);
  await assert.rejects(readMarketsAndCards(fakeConnection(mainnet)), /Devnet verification failed/);
  await assert.rejects(readWalletBalances(wallet, golden.markets, fakeConnection(mainnet, { accounts: walletAccounts() })), /Devnet verification failed/);
});

test("the browser's network check is kept for the tab: a new page load within the minute skips it", async () => {
  const store = new Map<string, string>();
  const methods: string[] = [];
  const g = globalThis as unknown as { window?: unknown; fetch: typeof fetch };
  const realFetch = g.fetch;
  g.fetch = (async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { id: unknown; method: string };
    methods.push(request.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: fixture.genesis }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  g.window = {
    location: { origin: "https://sonata.test" },
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  // Each import is a fresh copy of the module: a new page load in the same tab.
  const pageLoad = (): Promise<typeof import("./runtime.ts")> => import(`./runtime.ts?page=${Math.random()}`);
  try {
    const first = await pageLoad();
    await first.checkNetwork();
    assert.deepEqual(methods, ["getGenesisHash"]);
    const second = await pageLoad();
    await second.checkNetwork();
    assert.deepEqual(methods, ["getGenesisHash"], "skipped within the minute");
    // Older than a minute, dated in the future, or for other endpoints: checked again.
    for (const change of [
      (v: Record<string, unknown>) => ({ ...v, at: Date.now() - 61_000 }),
      (v: Record<string, unknown>) => ({ ...v, at: Date.now() + 3_600_000 }),
      (v: Record<string, unknown>) => ({ ...v, endpoints: "https://mainnet.example/" }),
    ]) {
      const [key, value] = [...store.entries()][0];
      store.set(key, JSON.stringify(change(JSON.parse(value))));
      const before = methods.length;
      const page = await pageLoad();
      await page.checkNetwork();
      assert.equal(methods.length, before + 1);
    }
  } finally {
    g.fetch = realFetch;
    delete g.window;
  }
});
