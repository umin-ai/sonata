// Decodes swap events from a transaction: Meteora DBC swaps on the bonding
// curve, and Meteora DAMM v2 (cp-amm) swaps in the pool a market graduates to.
// Both programs emit them with Anchor's event CPI: an inner instruction to the
// program itself whose data is the event-CPI tag, then the event's
// discriminator and Borsh fields. Reading the event gives the exact amounts,
// fees and post-trade price, rather than inferring them from balance changes.
// Only the program can sign as its own event authority, so an event CPI in a
// successful transaction is genuine.
import { readFileSync } from "node:fs";
import anchor from "@coral-xyz/anchor";
import bs58 from "bs58";
import { CpAmmIdl } from "@meteora-ag/cp-amm-sdk";

const dbcIdl = JSON.parse(
  readFileSync(new URL("../lib/treasury/dbc.json", import.meta.url), "utf8"),
);
export const DBC_PROGRAM = dbcIdl.address;
const coder = new anchor.BorshEventCoder(dbcIdl);
export const EVENT_CPI_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

// DAMM v2, from the SDK's own IDL (the program DBC migrates to).
export const DAMM_PROGRAM = CpAmmIdl.address;
const dammCoder = new anchor.BorshEventCoder(CpAmmIdl);
export const DAMM_SWAP_EVENT = CpAmmIdl.events.find((e) => e.name.toLowerCase() === "evtswap2").name;
// swap and swap2 share their account list; the event's parent is one of them.
const DAMM_SWAPS = CpAmmIdl.instructions.filter((i) => i.name === "swap" || i.name === "swap2");
const DAMM_SWAP_DISCRIMINATORS = DAMM_SWAPS.map((i) => Buffer.from(i.discriminator));
function swapAccount(name) {
  const [a, b] = DAMM_SWAPS.map((i) => i.accounts.findIndex((x) => x.name === name));
  if (DAMM_SWAPS.length !== 2 || a < 0 || a !== b) throw Error(`DAMM v2 swap accounts changed (${name})`);
  return a;
}
const SWAP_POOL = swapAccount("pool");
const SWAP_PAYER = swapAccount("payer");

// Every Sonata config uses 6 base and 8 quote decimals (lib/treasury/dbc-preview.ts).
export const BASE_DECIMALS = 6;
export const QUOTE_DECIMALS = 8;
export const SUPPLY_TOKENS = 1_000_000_000;

// DBC's sqrt price is Q64.64 of quote atoms per base atom.
export function priceFromSqrt(sqrtPrice, baseDecimals = BASE_DECIMALS, quoteDecimals = QUOTE_DECIMALS) {
  const s = Number(BigInt(sqrtPrice.toString())) / 2 ** 64;
  return s * s * 10 ** (baseDecimals - quoteDecimals);
}

function accountKeys(tx) {
  const msg = tx.transaction.message;
  const keys = (msg.staticAccountKeys ?? msg.accountKeys).map((k) => k.toBase58?.() ?? String(k));
  const loaded = tx.meta?.loadedAddresses;
  return loaded ? [...keys, ...loaded.writable.map(String), ...loaded.readonly.map(String)] : keys;
}

const bytesOf = (data) => Buffer.from(typeof data === "string" ? bs58.decode(data) : data);

// The transaction's top-level instructions as { programIdIndex, accounts, data }:
// web3.js messages (legacy and v0) have compiledInstructions, RPC JSON has instructions.
function outerInstructions(tx) {
  const msg = tx.transaction.message;
  if (msg.compiledInstructions)
    return msg.compiledInstructions.map((i) => ({ programIdIndex: i.programIdIndex, accounts: i.accountKeyIndexes, data: i.data }));
  return msg.instructions ?? [];
}

const isDammSwap = (keys, ix) =>
  keys[ix.programIdIndex] === DAMM_PROGRAM && DAMM_SWAP_DISCRIMINATORS.some((d) => bytesOf(ix.data).subarray(0, 8).equals(d));

// Borsh field names follow the IDL (snake_case in the SDK's raw IDL).
const field = (o, snake) => o[snake] ?? o[snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())];
const big = (v) => BigInt(v.toString());

// Returns one trade per DBC swap event in a successful transaction. The trader
// is the fee payer (the app's buys and sells are signed by the trader).
export function decodeTrades(tx, signature) {
  if (!tx?.meta || tx.meta.err) return [];
  const keys = accountKeys(tx);
  const trader = keys[0];
  const trades = [];
  let index = 0;
  for (const group of tx.meta.innerInstructions ?? []) {
    // swap2 emits both the legacy evtSwap and evtSwap2 for one trade; keep evtSwap2.
    const found = [];
    for (const ix of group.instructions) {
      index++;
      if (keys[ix.programIdIndex] !== DBC_PROGRAM) continue;
      const data = Buffer.from(typeof ix.data === "string" ? bs58.decode(ix.data) : ix.data);
      if (data.length < 16 || !data.subarray(0, 8).equals(EVENT_CPI_TAG)) continue;
      let event;
      try {
        event = coder.decode(data.subarray(8).toString("base64"));
      } catch {
        continue;
      }
      if (!event || (event.name !== "evtSwap2" && event.name !== "evtSwap")) continue;
      const d = event.data, r = d.swapResult;
      // TradeDirection: 0 = BaseToQuote (sell), 1 = QuoteToBase (buy).
      const buy = Number(d.tradeDirection) === 1;
      const input = BigInt((r.includedFeeInputAmount ?? r.actualInputAmount).toString());
      const output = BigInt(r.outputAmount.toString());
      const fee =
        BigInt(r.tradingFee.toString()) + BigInt(r.protocolFee.toString()) + BigInt(r.referralFee.toString());
      found.push({
        event: event.name,
        signature,
        ixIndex: index,
        pool: d.pool.toBase58(),
        venue: "dbc",
        side: buy ? "buy" : "sell",
        trader,
        baseAmount: (buy ? output : input).toString(),
        quoteAmount: (buy ? input : output).toString(),
        fee: fee.toString(),
        price: priceFromSqrt(r.nextSqrtPrice),
        slot: tx.slot,
        blockTime: tx.blockTime,
      });
    }
    const modern = found.some((t) => t.event === "evtSwap2");
    for (const { event, ...t } of found) if (!modern || event === "evtSwap2") trades.push(t);
  }
  return trades;
}

// The account that paid for the DAMM v2 swap that emitted the event at
// group.instructions[position]: the nearest cp-amm swap on `pool` before it, in
// the same inner group (a swap routed through another program) or the group's
// top-level instruction (a direct swap), one call level up when the RPC reports
// stack heights. Null if none is found.
function dammSwapPayer(tx, keys, group, position, pool) {
  const height = group.instructions[position].stackHeight;
  const parent = (ix, h) =>
    ix && isDammSwap(keys, ix) && keys[ix.accounts[SWAP_POOL]] === pool && (height == null || h == null || h === height - 1);
  for (let k = position - 1; k >= 0; k--) {
    const ix = group.instructions[k];
    if (parent(ix, ix.stackHeight)) return keys[ix.accounts[SWAP_PAYER]];
  }
  const outer = outerInstructions(tx)[group.index];
  return parent(outer, 1) ? keys[outer.accounts[SWAP_PAYER]] : null;
}

/**
 * One trade per DAMM v2 (cp-amm) EvtSwap2 event in a successful transaction,
 * in the same shape as decodeTrades, for a pool whose token A is the market's
 * base token and token B its quote (how DBC migrates Sonata's markets). Each
 * trade's `pool` is the DAMM v2 pool; the indexer files it under the market's
 * DBC pool.
 * The trader is the swap's payer (the signer whose tokens went in), which is
 * the fee payer unless the swap was routed through another program.
 * TradeDirection: 0 = AtoB (base in: sell), 1 = BtoA (quote in: buy). The fee
 * is every fee component the swap charged, in the fee token (quote for
 * Sonata's pools, which collect fees in token B).
 */
export function decodeDammTrades(tx, signature) {
  if (!tx?.meta || tx.meta.err) return [];
  const keys = accountKeys(tx);
  const trades = [];
  let index = 0;
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const [position, ix] of group.instructions.entries()) {
      index++;
      if (keys[ix.programIdIndex] !== DAMM_PROGRAM) continue;
      const data = bytesOf(ix.data);
      if (data.length < 16 || !data.subarray(0, 8).equals(EVENT_CPI_TAG)) continue;
      let event;
      try {
        event = dammCoder.decode(data.subarray(8).toString("base64"));
      } catch {
        continue;
      }
      if (!event || event.name !== DAMM_SWAP_EVENT) continue;
      const d = event.data, r = field(d, "swap_result");
      const pool = field(d, "pool").toBase58();
      const buy = Number(field(d, "trade_direction")) === 1;
      const input = big(field(r, "included_fee_input_amount"));
      const output = big(field(r, "output_amount"));
      const fee = ["claiming_fee", "protocol_fee", "compounding_fee", "referral_fee"].reduce((s, k) => s + big(field(r, k) ?? 0), 0n);
      trades.push({
        signature,
        ixIndex: index,
        pool,
        venue: "damm",
        side: buy ? "buy" : "sell",
        trader: dammSwapPayer(tx, keys, group, position, pool) ?? keys[0],
        baseAmount: (buy ? output : input).toString(),
        quoteAmount: (buy ? input : output).toString(),
        fee: fee.toString(),
        price: priceFromSqrt(field(r, "next_sqrt_price")),
        slot: tx.slot,
        blockTime: tx.blockTime,
      });
    }
  }
  return trades;
}
