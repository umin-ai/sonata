// Live Meteora pools on Solana mainnet that hold one of the real stocks Sonata
// pairs with (xStocks and PreStocks), read from Meteora's public pool data: the
// same numbers app.meteora.ag shows. Sonata only lists them. Adding liquidity
// happens on Meteora, with the viewer's own mainnet wallet.
import { XSTOCK_MINTS, stockFamily, type StockFamily } from "../pricing/stock-price.ts";

// Smaller pools are hidden: they are mostly empty or abandoned.
export const MIN_POOL_TVL_USD = 1_000;
export const PAGE_SIZE = 50;

export type PoolKind = "dlmm" | "damm-v2";
export const POOL_KINDS: readonly PoolKind[] = ["dlmm", "damm-v2"];
export const KIND_LABEL: Record<PoolKind, string> = { dlmm: "DLMM", "damm-v2": "DAMM v2" };

export type MainnetStock = { symbol: string; mint: string; family: StockFamily };
/** Each stock Sonata pairs with, by its real mint on mainnet (mock quote → real token). */
export const MAINNET_STOCKS: MainnetStock[] = Object.entries(XSTOCK_MINTS).map(([quote, s]) => ({
  symbol: s.symbol,
  mint: s.mint,
  family: stockFamily(quote),
}));
const STOCK_BY_MINT = new Map(MAINNET_STOCKS.map((s) => [s.mint, s]));

export type PoolToken = { mint: string; symbol: string; verified: boolean; stock: boolean };
export type MainnetPool = {
  address: string;
  kind: PoolKind;
  x: PoolToken;
  y: PoolToken;
  /** Sonata's stocks in the pool: usually one, two for a pair like NVDAx-TSLAx. */
  stocks: string[];
  families: StockFamily[];
  /** The other token is one Meteora has not verified. Much of such a pool's value is that token, priced by the pool itself. */
  unverified: boolean;
  tvl: number;
  volume24h: number;
  /** The last 24 hours of fees paid to liquidity providers: all fees less Meteora's protocol share. */
  lpFees24h: number;
  /** The pool's base fee, in percent. */
  feePct: number;
  /** lpFees24h as a percent of the pool's liquidity. */
  lpFeeTvl24h: number;
};

/** A stock's Token-2022 transfer fee: taken on every transfer, deposits and withdrawals included. */
export type TransferFee = { bps: number; next?: { bps: number; inDays: number } };

export const poolDataUrl = (kind: PoolKind, mint: string, page = 1) =>
  `https://${kind}.datapi.meteora.ag/pools?query=${mint}&page_size=${PAGE_SIZE}&sort_by=tvl:desc&page=${page}`;
export const meteoraPoolUrl = (p: Pick<MainnetPool, "kind" | "address">) =>
  `https://app.meteora.ag/${p.kind === "dlmm" ? "dlmm" : "dammv2"}/${p.address}`;
export const mainnetExplorer = (address: string) => `https://explorer.solana.com/address/${address}`;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const amount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

type RawToken = { address?: unknown; symbol?: unknown; is_verified?: unknown };
type RawPool = {
  address?: unknown;
  token_x?: RawToken;
  token_y?: RawToken;
  tvl?: unknown;
  volume?: Record<string, unknown>;
  fees?: Record<string, unknown>;
  protocol_fees?: Record<string, unknown>;
  pool_config?: { base_fee_pct?: unknown };
  is_blacklisted?: unknown;
};

// A stock is recognised by its mint only, so a look-alike token named "NVDAx"
// shows as the unverified token it is.
function token(raw: RawToken | undefined): PoolToken | null {
  const mint = raw?.address;
  if (typeof mint !== "string" || !BASE58.test(mint)) return null;
  const stock = STOCK_BY_MINT.get(mint);
  const named = typeof raw?.symbol === "string" ? raw.symbol.trim().slice(0, 16) : "";
  return {
    mint,
    symbol: stock?.symbol ?? (named || `${mint.slice(0, 4)}…`),
    verified: !!stock || raw?.is_verified === true,
    stock: !!stock,
  };
}

export type PoolPage = {
  pools: MainnetPool[];
  /** Pools Meteora itself flags, left out. */
  flagged: number;
  /** Another page holds pools large enough to list. */
  more: boolean;
};

/** One page of Meteora's pool data, cut to live pools that really hold one of the stocks. */
export function parsePools(kind: PoolKind, body: unknown): PoolPage {
  const page = body as { data?: unknown; pages?: unknown; current_page?: unknown } | null;
  const rows = page?.data;
  if (!Array.isArray(rows)) throw Error("Meteora returned no pool list.");
  const pools: MainnetPool[] = [];
  let flagged = 0,
    last = 0;
  for (const r of rows as RawPool[]) {
    if (!r) continue;
    last = amount(r.tvl);
    const address = r.address;
    if (typeof address !== "string" || !BASE58.test(address)) continue;
    const x = token(r.token_x),
      y = token(r.token_y);
    if (!x || !y) continue;
    // The search also matches names, so keep only pools holding the real mint.
    const stocks = [x, y].filter((t) => t.stock).map((t) => t.symbol);
    if (!stocks.length) continue;
    const tvl = amount(r.tvl);
    if (tvl < MIN_POOL_TVL_USD) continue;
    if (r.is_blacklisted === true) {
      flagged++;
      continue;
    }
    const lpFees24h = Math.max(0, amount(r.fees?.["24h"]) - amount(r.protocol_fees?.["24h"]));
    pools.push({
      address,
      kind,
      x,
      y,
      stocks,
      families: [...new Set(stocks.map((s) => MAINNET_STOCKS.find((m) => m.symbol === s)!.family))],
      unverified: !x.verified || !y.verified,
      tvl,
      volume24h: amount(r.volume?.["24h"]),
      lpFees24h,
      feePct: amount(r.pool_config?.base_fee_pct),
      lpFeeTvl24h: (lpFees24h / tvl) * 100,
    });
  }
  // Rows come largest first, so only a full page ending above the floor can hide more.
  const pages = typeof page?.pages === "number" ? page.pages : 1,
    current = typeof page?.current_page === "number" ? page.current_page : 1;
  return { pools, flagged, more: current < pages && rows.length >= PAGE_SIZE && last >= MIN_POOL_TVL_USD };
}

/** Every query's pools as one list: each pool once, largest first. */
export function mergePools(lists: MainnetPool[][]): MainnetPool[] {
  const byAddress = new Map<string, MainnetPool>();
  for (const p of lists.flat()) if (!byAddress.has(p.address)) byAddress.set(p.address, p);
  return [...byAddress.values()].sort((a, b) => b.tvl - a.tvl);
}

type FeeState = { epoch?: unknown; transferFeeBasisPoints?: unknown };
/**
 * The transfer fee in force now, from a mint's parsed transferFeeConfig. Token-2022
 * applies the newer fee from its epoch on, so a scheduled change is reported too.
 */
export function transferFeeAt(
  config: { olderTransferFee?: FeeState; newerTransferFee?: FeeState } | undefined,
  epoch: number,
  slotsLeftInEpoch: number,
  slotsPerEpoch: number,
): TransferFee | undefined {
  const older = config?.olderTransferFee,
    newer = config?.newerTransferFee;
  const bps = (f?: FeeState) => (typeof f?.transferFeeBasisPoints === "number" ? f.transferFeeBasisPoints : 0);
  const newerEpoch = typeof newer?.epoch === "number" ? newer.epoch : 0;
  const now = epoch >= newerEpoch ? bps(newer) : bps(older);
  const next =
    epoch < newerEpoch && bps(newer) !== now
      ? {
          bps: bps(newer),
          // About 0.4 seconds per slot.
          inDays: Math.max(1, Math.round(((slotsLeftInEpoch + (newerEpoch - epoch - 1) * slotsPerEpoch) * 0.4) / 86_400)),
        }
      : undefined;
  return now || next ? { bps: now, ...(next && { next }) } : undefined;
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
export const compactUsd = (v: number) => (v > 0 && v < 1 ? "<$1" : USD.format(v));
export const percentText = (v: number) => `${Number(v.toFixed(v < 1 ? 2 : 1))}%`;
