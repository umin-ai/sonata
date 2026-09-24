import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { Keypair, Message, MessageV0, PublicKey } from "@solana/web3.js";
import { decodeDammTrades, decodeTrades, priceFromSqrt, SUPPLY_TOKENS } from "./parse.mjs";
// A DAMM v2 swap transaction with its EvtSwap2 event built from the SDK's IDL layout.
import { dammSwapTx } from "./modules/testkit.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

test("decodes a real Devnet buy made through the app", () => {
  // 2kjcad7q…: 0.02 mQQQ for 1,905,864.930164 FLOOR on the Stock Floor proof pool.
  const trades = decodeTrades(fixture("app-buy.json"), "sig");
  assert.equal(trades.length, 1, "legacy evtSwap is not double counted");
  const [t] = trades;
  assert.equal(t.pool, "9iuQLtqQETzEjGrPVycWFoANL22W9s3MoNfTt2dfxong");
  assert.equal(t.side, "buy");
  assert.equal(t.trader, "GX3N5UEDE4YBSC46ZND8YZbxP8ynZWtyQNtp5EqjezQ3");
  assert.equal(t.quoteAmount, "2000000");
  assert.equal(t.baseAmount, "1905864930164");
  assert.equal(t.fee, "60000"); // 3%
  // Market cap after the trade, in mQQQ: about 10.2.
  assert.ok(Math.abs(t.price * SUPPLY_TOKENS - 10.198) < 0.01);
});

test("failed transactions produce no trades", () => {
  const tx = fixture("app-buy.json");
  assert.deepEqual(decodeTrades({ ...tx, meta: { ...tx.meta, err: { InstructionError: [0, "x"] } } }, "s"), []);
});

test("Q64.64 sqrt price converts to quote tokens per base token", () => {
  // sqrt = 2^64 means 1 quote atom per base atom = 0.01 quote tokens per base token at 6/8 decimals.
  assert.equal(priceFromSqrt(2n ** 64n), 0.01);
});

// ---- DAMM v2 (the pool a market graduates to) -------------------------------

test("a DAMM v2 buy (quote in, token B) decodes with the swap's payer as trader and every fee part", () => {
  const pool = Keypair.generate().publicKey, feePayer = Keypair.generate().publicKey, payer = Keypair.generate().publicKey;
  const tx = dammSwapTx({ direction: 1, pool, feePayer, payer, result: { referral_fee: 500n, compounding_fee: 250n } });
  const trades = decodeDammTrades(tx, "sig");
  assert.equal(trades.length, 1);
  const [t] = trades;
  assert.equal(t.pool, pool.toBase58());
  assert.equal(t.venue, "damm");
  assert.equal(t.side, "buy");
  // The swap's payer, not the fee payer: a relayer paying fees is not the buyer.
  assert.equal(t.trader, payer.toBase58());
  assert.equal(t.quoteAmount, "1000000"); // quote in, fee included
  assert.equal(t.baseAmount, "49000000"); // base out
  assert.equal(t.fee, String(10_000 + 2_500 + 250 + 500));
  assert.equal(t.price, 0.01); // sqrt 2^64 at 6/8 decimals, as DBC's
  assert.equal(t.slot, 500_000_000);
  assert.equal(t.blockTime, 1_790_000_000);
  // Indexed like DBC events: the event's place among the inner instructions.
  assert.equal(t.ixIndex, 3);
  // The DBC decoder never reads DAMM events, nor the DAMM decoder DBC ones.
  assert.deepEqual(decodeTrades(tx, "sig"), []);
  assert.deepEqual(decodeDammTrades(fixture("app-buy.json"), "sig"), []);
});

test("a DAMM v2 sell (base in, token A) routed through another program is the inner swap's payer's", () => {
  const payer = Keypair.generate().publicKey;
  const [t] = decodeDammTrades(dammSwapTx({ direction: 0, routed: true, payer }), "sig");
  assert.equal(t.side, "sell");
  assert.equal(t.trader, payer.toBase58());
  assert.equal(t.baseAmount, "1000000"); // base in
  assert.equal(t.quoteAmount, "49000000"); // quote out, after the fee
  // Without the swap instruction (not found), the fee payer is the trader.
  const feePayer = Keypair.generate().publicKey;
  const bare = dammSwapTx({ direction: 0, feePayer });
  bare.transaction.message.instructions[1].data = "1";
  assert.equal(decodeDammTrades(bare, "sig")[0].trader, feePayer.toBase58());
});

test("a direct DAMM v2 swap finds its payer in web3.js messages too (legacy and v0), as the indexer's getTransaction returns them", () => {
  const payer = Keypair.generate().publicKey;
  const tx = dammSwapTx({ direction: 1, payer });
  const raw = tx.transaction.message;
  const header = { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 };
  const legacy = new Message({ header, accountKeys: raw.accountKeys, recentBlockhash: raw.accountKeys[0], instructions: raw.instructions });
  const v0 = new MessageV0({
    header, staticAccountKeys: raw.accountKeys.map((k) => new PublicKey(k)), recentBlockhash: raw.accountKeys[0], addressTableLookups: [],
    compiledInstructions: raw.instructions.map((i) => ({ programIdIndex: i.programIdIndex, accountKeyIndexes: i.accounts, data: bs58.decode(i.data) })),
  });
  for (const message of [legacy, v0]) {
    const [t] = decodeDammTrades({ ...tx, transaction: { message, signatures: [] } }, "sig");
    assert.equal(t.trader, payer.toBase58());
    assert.equal(t.side, "buy");
  }
});

test("DAMM v2 events are read only from cp-amm itself, and not from failed transactions", () => {
  const tx = dammSwapTx({ direction: 1 });
  assert.deepEqual(decodeDammTrades({ ...tx, meta: { ...tx.meta, err: { InstructionError: [1, "x"] } } }, "s"), []);
  // The same bytes from another program are not an event.
  const spoof = structuredClone(tx);
  const keys = spoof.transaction.message.accountKeys;
  const ev = spoof.meta.innerInstructions[0].instructions.at(-1);
  ev.programIdIndex = keys.push(Keypair.generate().publicKey.toBase58()) - 1;
  assert.deepEqual(decodeDammTrades(spoof, "s"), []);
  assert.deepEqual(decodeDammTrades(null, "s"), []);
});

test("decodes a real Devnet DAMM v2 swap: EvtSwap2 as the deployed program emits it", () => {
  // 3SDve287…: a routed sell of 684,932 (9-decimal) base for 0.686612765 SOL on
  // pool Ae7PTx64…; token balances in the fixture move by exactly these amounts.
  const [t, ...rest] = decodeDammTrades(fixture("damm-swap.json"), "3SDve287");
  assert.equal(rest.length, 0);
  assert.equal(t.pool, "Ae7PTx64j3q12VWBq849R9SRiYAtVzQHvszfqiN5jLEr");
  assert.equal(t.side, "sell");
  // This swap's payer GctMdSxF… is a program address (off the ed25519 curve), so the
  // trade is the transaction signer's, 22MmJKBP…, not the program's.
  assert.equal(t.trader, "22MmJKBP8BXHdPEEuJuwq9AMq2Q5eP8VjYDq2E5Mtz4b");
  assert.equal(t.baseAmount, "684932000000000");
  assert.equal(t.quoteAmount, "686612765");
  assert.equal(t.fee, "14012506");
  assert.equal(t.slot, 503479128);
  assert.equal(t.blockTime, 1790254905);
  assert.equal(t.ixIndex, 7);
});

// ---- Who a trade is booked to: the swap's payer, not the fee payer -----------

// The Devnet buy in app-buy.json with its DBC swap signed by `payers` (one
// swap each, the fixture's own swap copied) while the fee payer stays the
// fixture's GX3N5UED…. `routed` moves the swaps inside another program's
// instruction (as an aggregator does); `heights: false` drops the stack
// heights, as older RPC responses do.
const FIXTURE_FEE_PAYER = "GX3N5UEDE4YBSC46ZND8YZbxP8ynZWtyQNtp5EqjezQ3";
const DBC_SWAP_PAYER = 9; // swap / swap2 accounts: … baseMint, quoteMint, payer
function dbcSwapTx({ payers, routed = false, heights = true }) {
  const tx = structuredClone(fixture("app-buy.json"));
  const msg = tx.transaction.message;
  const at = (k) => (msg.accountKeys.includes(k) ? msg.accountKeys.indexOf(k) : msg.accountKeys.push(k) - 1);
  const swap = msg.instructions[2];
  const group = tx.meta.innerInstructions.find((g) => g.index === 2);
  const emitted = group.instructions;
  const swaps = payers.map((p) => ({ ...swap, accounts: swap.accounts.map((a, i) => (i === DBC_SWAP_PAYER ? at(p.toBase58()) : a)) }));
  if (routed) {
    msg.instructions[2] = { accounts: [at(Keypair.generate().publicKey.toBase58())], data: "1", programIdIndex: at(Keypair.generate().publicKey.toBase58()), stackHeight: 1 };
    group.instructions = swaps.flatMap((s) => [{ ...s, stackHeight: 2 }, ...emitted.map((i) => ({ ...i, stackHeight: 3 }))]);
  } else {
    assert.equal(payers.length, 1, "a direct swap is the top-level instruction");
    msg.instructions[2] = swaps[0];
  }
  if (!heights) for (const g of tx.meta.innerInstructions) for (const i of g.instructions) delete i.stackHeight;
  return tx;
}

test("a DBC trade is the swap payer's, not the fee payer's: direct, routed through another program, and without stack heights", () => {
  const payer = Keypair.generate().publicKey;
  // The fixture as recorded: the app's trader signs the swap and pays the fee.
  assert.equal(decodeTrades(dbcSwapTx({ payers: [new PublicKey(FIXTURE_FEE_PAYER)] }), "sig")[0].trader, FIXTURE_FEE_PAYER);
  for (const options of [{}, { routed: true }, { heights: false }, { routed: true, heights: false }]) {
    const trades = decodeTrades(dbcSwapTx({ payers: [payer], ...options }), "sig");
    assert.equal(trades.length, 1, JSON.stringify(options));
    assert.equal(trades[0].trader, payer.toBase58(), `a relayer paying the fee is not the buyer (${JSON.stringify(options)})`);
    assert.equal(trades[0].baseAmount, "1905864930164");
  }
});

test("two DBC swaps routed in one instruction are each booked to their own payer", () => {
  const [p, q] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  for (const heights of [true, false]) {
    const trades = decodeTrades(dbcSwapTx({ payers: [p, q], routed: true, heights }), "sig");
    assert.deepEqual(trades.map((t) => t.trader), [p.toBase58(), q.toBase58()], `heights: ${heights}`);
    assert.equal(new Set(trades.map((t) => t.ixIndex)).size, 2);
  }
});

test("an event whose caller is not a swap on its pool is the fee payer's, never an earlier swap's payer", () => {
  // DAMM v2: the event's caller (one level up) is another program's
  // instruction, after a real swap by someone else in the same routed instruction.
  const [payer, feePayer] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const tx = dammSwapTx({ direction: 1, routed: true, payer, feePayer });
  const keys = tx.transaction.message.accountKeys;
  const inner = tx.meta.innerInstructions[0].instructions;
  inner.splice(inner.length - 1, 0, { accounts: [], data: "1", programIdIndex: keys.push(Keypair.generate().publicKey.toBase58()) - 1, stackHeight: 2 });
  assert.equal(decodeDammTrades(tx, "sig")[0].trader, feePayer.toBase58());
  // DBC: a swap on another pool is not this event's swap.
  const dbc = dbcSwapTx({ payers: [payer] });
  const msg = dbc.transaction.message;
  msg.instructions[2].accounts[2] = msg.accountKeys.push(Keypair.generate().publicKey.toBase58()) - 1;
  assert.equal(decodeTrades(dbc, "sig")[0].trader, FIXTURE_FEE_PAYER);
});

test("a swap whose payer is a program address (an aggregator route) is the transaction signer's", () => {
  // Jupiter's shared-accounts route swaps with its own PDA as payer; the user signs.
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("shared")], Keypair.generate().publicKey);
  assert.equal(PublicKey.isOnCurve(pda.toBytes()), false);
  for (const options of [{}, { routed: true }, { heights: false }]) {
    const trades = decodeTrades(dbcSwapTx({ payers: [pda], ...options }), "sig");
    assert.equal(trades[0].trader, FIXTURE_FEE_PAYER, JSON.stringify(options));
  }
  const feePayer = Keypair.generate().publicKey;
  assert.equal(decodeDammTrades(dammSwapTx({ direction: 1, payer: pda, feePayer }), "sig")[0].trader, feePayer.toBase58());
});
