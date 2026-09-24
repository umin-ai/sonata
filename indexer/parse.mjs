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
import { PublicKey } from "@solana/web3.js";

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

// The swap instructions that emit each program's swap events, from its IDL:
// their discriminators and where `pool` and `payer` (the signer whose token
// accounts the swap debits and credits) sit in their account lists, which
// every variant shares. Throws at load if an IDL update breaks that.
function swapLayout(idl, names, label) {
  const swaps = idl.instructions.filter((i) => names.includes(i.name));
  const at = (name) => {
    const found = swaps.map((i) => i.accounts.findIndex((x) => x.name === name));
    if (swaps.length !== names.length || found.some((k) => k < 0 || k !== found[0])) throw Error(`${label} swap accounts changed (${name})`);
    return found[0];
  };
  const payer = at("payer");
  if (swaps.some((i) => !i.accounts[payer].signer)) throw Error(`${label} swap payer is no longer a signer`);
  return { program: idl.address, discriminators: swaps.map((i) => Buffer.from(i.discriminator)), pool: at("pool"), payer };
}
const DBC_SWAPS = swapLayout(dbcIdl, ["swap", "swap2", "swap2WithTransferHook"], "DBC");
const DAMM_SWAPS = swapLayout(CpAmmIdl, ["swap", "swap2"], "DAMM v2");

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

// Borsh field names follow the IDL (snake_case in the SDK's raw IDL).
const field = (o, snake) => o[snake] ?? o[snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())];
const big = (v) => BigInt(v.toString());

/**
 * Who made the swap whose event is group.instructions[position], on `pool`:
 * the `payer` of the swap instruction that emitted the event, if that
 * instruction is one of `layout`'s swaps on the pool. The payer signs for the
 * token accounts the swap takes from, so it is the trader even when another
 * wallet pays the transaction fee or the swap runs inside another program (an
 * aggregator passing the user's signature on, or a program swapping for its
 * own PDA, which then never wins anything: it is not a wallet).
 * The emitting instruction is the event's caller. With stack heights (every
 * current RPC reports them), that is the nearest earlier instruction one level
 * up in the same inner group, or the group's top-level instruction for an
 * event at level 2. Without them, it is the nearest earlier matching swap in
 * the group, else the top-level instruction.
 * If the caller is not a recognized swap on the pool (no known program
 * version does this), the trade is booked to the fee payer, as every trade was
 * before, rather than to some other swap's payer.
 */
function swapTrader(tx, keys, group, position, pool, layout) {
  const isSwap = (ix) =>
    ix != null &&
    keys[ix.programIdIndex] === layout.program &&
    layout.discriminators.some((d) => bytesOf(ix.data).subarray(0, 8).equals(d)) &&
    keys[ix.accounts[layout.pool]] === pool;
  const top = () => outerInstructions(tx)[group.index];
  const height = group.instructions[position].stackHeight;
  let caller = null;
  if (height == null) caller = group.instructions.slice(0, position).findLast(isSwap) ?? top();
  else if (height === 2) caller = top();
  else
    for (let k = position - 1; k >= 0; k--) {
      const h = group.instructions[k].stackHeight;
      if (h === height - 1) caller = group.instructions[k];
      if (h == null || h < height) break;
    }
  const payer = isSwap(caller) ? keys[caller.accounts[layout.payer]] : null;
  // A payer that is not a wallet is a program's own address: an aggregator's
  // shared-accounts route, or a program swapping for its PDA. The trade is then
  // the transaction signer's (the fee payer's), as before, so a user routing
  // through Jupiter keeps their trade and nobody hides trades behind a PDA.
  return payer && isWallet(payer) ? payer : keys[0];
}
const isWallet = (key) => {
  try {
    return PublicKey.isOnCurve(new PublicKey(key).toBytes());
  } catch {
    return false;
  }
};

// One trade per DBC swap event in a successful transaction, booked to the
// swap's payer (swapTrader). swap2 emits both the legacy evtSwap and evtSwap2
// for one trade; keep evtSwap2.
export function decodeTrades(tx, signature) {
  if (!tx?.meta || tx.meta.err) return [];
  const keys = accountKeys(tx);
  const trades = [];
  let index = 0;
  for (const group of tx.meta.innerInstructions ?? []) {
    const found = [];
    for (const [position, ix] of group.instructions.entries()) {
      index++;
      if (keys[ix.programIdIndex] !== DBC_PROGRAM) continue;
      const data = bytesOf(ix.data);
      if (data.length < 16 || !data.subarray(0, 8).equals(EVENT_CPI_TAG)) continue;
      let event;
      try {
        event = coder.decode(data.subarray(8).toString("base64"));
      } catch {
        continue;
      }
      if (!event || (event.name !== "evtSwap2" && event.name !== "evtSwap")) continue;
      const d = event.data, r = d.swapResult;
      const pool = d.pool.toBase58();
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
        pool,
        venue: "dbc",
        side: buy ? "buy" : "sell",
        trader: swapTrader(tx, keys, group, position, pool, DBC_SWAPS),
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

/**
 * One trade per DAMM v2 (cp-amm) EvtSwap2 event in a successful transaction,
 * in the same shape as decodeTrades, for a pool whose token A is the market's
 * base token and token B its quote (how DBC migrates Sonata's markets). Each
 * trade's `pool` is the DAMM v2 pool; the indexer files it under the market's
 * DBC pool. The trader is the swap's payer (swapTrader).
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
        trader: swapTrader(tx, keys, group, position, pool, DAMM_SWAPS),
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
