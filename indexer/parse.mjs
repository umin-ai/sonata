// Decodes Meteora DBC swap events from a transaction. DBC emits them with
// Anchor's event CPI: an inner instruction to the DBC program whose data is
// the event-CPI tag, then the event's discriminator and Borsh fields. Reading
// the event gives the exact amounts, fees and post-trade price, rather than
// inferring them from balance changes.
import { readFileSync } from "node:fs";
import anchor from "@coral-xyz/anchor";
import bs58 from "bs58";

const dbcIdl = JSON.parse(
  readFileSync(new URL("../lib/treasury/dbc.json", import.meta.url), "utf8"),
);
export const DBC_PROGRAM = dbcIdl.address;
const coder = new anchor.BorshEventCoder(dbcIdl);
const EVENT_CPI_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

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

// Returns one trade per DBC swap event in a successful transaction.
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
