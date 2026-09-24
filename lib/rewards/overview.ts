// The Rewards page's reads: what Sonata's payout bot pays and has paid, per
// market (the trade indexer's /api/index/rewards) and per wallet
// (/api/index/payouts), and what a wallet's Backed tokens are worth from their
// backing (one getTokenAccountsByOwner call for all its base tokens).
//
// Top-level imports stay node-loadable so the helpers can be unit tested; the
// app runtime loads lazily.
// SPL Token needs Buffer while its module loads.
import "../stockroom/polyfills.mjs";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { floorShare } from "../treasury/floor.ts";

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)

/** What the bot can run for a Reward token: holder rewards or a fee module. */
export const BOT_MODELS = ["holders", "buyback", "topBuyers", "lpFarm", "split", "diamond"] as const;
export type BotModel = (typeof BOT_MODELS)[number];
const isBotModel = (v: unknown): v is BotModel =>
  typeof v === "string" && (BOT_MODELS as readonly string[]).includes(v);

/**
 * The model a Reward token runs: the first known one of `candidates` (the
 * bot's own record, then the token's metadata), else holder rewards, which is
 * what the bot runs when the metadata names nothing it knows.
 */
export function botModel(...candidates: (string | null | undefined)[]): BotModel {
  return candidates.find(isBotModel) ?? "holders";
}

/**
 * Whether the page lists a Reward token as paying: holder rewards always; a
 * fee module only once the new payout bot runs them (lib/features.ts).
 */
export const listsModel = (model: BotModel, botV2: boolean) => model === "holders" || botV2;

export type PayoutKind = BotModel | "airdrop";
/** A payout kind's name, as the market page names it. */
export const KIND_NAMES: Record<PayoutKind, string> = {
  holders: "Holder rewards",
  buyback: "Buyback & burn",
  topBuyers: "Top Buyer Bounty",
  lpFarm: "LP Farm",
  split: "Split",
  diamond: "Diamond Hands",
  airdrop: "Graduation airdrop",
};
export const kindName = (kind: string) => KIND_NAMES[kind as PayoutKind] ?? kind;

/** Who a market pays, in a few words. `lpStatus` is LP Farm's current recipients. */
export function paysWhom(kind: PayoutKind, lpStatus?: string) {
  switch (kind) {
    case "holders":
      return "Holders, pro rata";
    case "buyback":
      return "Buys the token and burns it";
    case "topBuyers":
      return "Top 3 buyers each round";
    case "lpFarm":
      return lpStatus === "lps" ? "Liquidity providers, pro rata" : "Holders now, LPs after graduation";
    case "split":
      return "Fixed wallets, by share";
    case "diamond":
      return "Holders, more the longer they hold";
    case "airdrop":
      return "Holders, once at graduation";
  }
}

/** "just now", "5 min ago", "3 h ago", "2 d ago": from unix seconds, relative to `now` (ms). */
export function sinceText(seconds: number, now: number) {
  const mins = Math.max(0, Math.round((now / 1000 - seconds) / 60));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** What the indexer reports the bot has done for one market (GET /api/index/rewards). */
export type MarketPayouts = {
  paid: string;
  payouts: number;
  lastPaidAt: number | null;
  feeModel: string | null;
  burned?: string;
  status?: string;
  splitError?: string;
  airdrop?: { status: string; amount: string | null; recipients: number; sentAt: number | null };
};
const ATOMS = /^[0-9]+$/;
const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);

/** A /api/index/rewards answer, checked; null if it is not one. */
export function parseMarketPayouts(json: unknown): MarketPayouts | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  if (typeof j.paid !== "string" || !ATOMS.test(j.paid)) return null;
  const a = j.airdrop as Record<string, unknown> | undefined;
  return {
    paid: j.paid,
    payouts: count(j.payouts),
    lastPaidAt: time(j.lastPaidAt),
    feeModel: typeof j.feeModel === "string" ? j.feeModel : null,
    ...(typeof j.burned === "string" && ATOMS.test(j.burned) ? { burned: j.burned } : {}),
    ...(typeof j.status === "string" ? { status: j.status } : {}),
    ...(typeof j.splitError === "string" ? { splitError: j.splitError } : {}),
    ...(a && typeof a === "object"
      ? {
          airdrop: {
            status: a.status === "sent" ? "sent" : "waiting",
            amount: typeof a.amount === "string" && ATOMS.test(a.amount) ? a.amount : null,
            recipients: count(a.recipients),
            sentAt: time(a.sentAt),
          },
        }
      : {}),
  };
}

/** One market and kind of payout to a wallet (GET /api/index/payouts). */
export type WalletPayout = {
  pool: string;
  module: string;
  /** "base": paid in the market's own token (the airdrop); "quote": in its stock. */
  asset: "quote" | "base";
  paid: string;
  payouts: number;
  lastPaidAt: number | null;
};
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A /api/index/payouts answer for `wallet`, checked; null if it is not one. Bad rows are left out. */
export function parseWalletPayouts(json: unknown, wallet: string): WalletPayout[] | null {
  if (!json || typeof json !== "object") return null;
  const j = json as { wallet?: unknown; payouts?: unknown };
  if (j.wallet !== wallet || !Array.isArray(j.payouts)) return null;
  return j.payouts.flatMap((r): WalletPayout[] => {
    if (!r || typeof r !== "object") return [];
    const p = r as Record<string, unknown>;
    if (typeof p.pool !== "string" || !ADDRESS.test(p.pool)) return [];
    if (typeof p.module !== "string" || !p.module || p.module.length > 32) return [];
    if (typeof p.paid !== "string" || !ATOMS.test(p.paid)) return [];
    const asset = p.asset === "base" || p.module === "airdrop" ? "base" : "quote";
    return [{ pool: p.pool, module: p.module, asset, paid: p.paid, payouts: count(p.payouts), lastPaidAt: time(p.lastPaidAt) }];
  });
}

/**
 * What a wallet has been paid in each stock: quote-asset payouts summed by
 * the market's quote mint (`quoteOf(pool)`), largest first. Payouts of a pool
 * `quoteOf` does not know are left out.
 */
export function stockTotals(rows: WalletPayout[], quoteOf: (pool: string) => string | undefined) {
  const totals = new Map<string, bigint>();
  for (const r of rows) {
    const mint = r.asset === "quote" ? quoteOf(r.pool) : undefined;
    if (mint) totals.set(mint, (totals.get(mint) ?? 0n) + BigInt(r.paid));
  }
  return [...totals].map(([mint, amount]) => ({ mint, amount })).sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
}

export type TokenHolding = { mint: string; owner: string; amount: bigint; frozen: boolean };
/** A wallet's balance per mint over its token accounts; frozen accounts and other owners' are left out. */
export function balancesByMint(accounts: TokenHolding[], wallet: string) {
  const out = new Map<string, bigint>();
  for (const a of accounts)
    if (a.owner === wallet && !a.frozen && a.amount > 0n) out.set(a.mint, (out.get(a.mint) ?? 0n) + a.amount);
  return out;
}

/** A Backed token's backing and supply; null when they could not be read. */
export type Backing = { pool: string; baseMint: string; floor: bigint | null; supply: bigint | null };
/**
 * Each Backed token the wallet holds, with the stock its tokens would get
 * from the backing if all were burned (floorShare, as the program pays; null
 * when the backing is unknown), most valuable first.
 */
export function walletBacking(backed: Backing[], balances: Map<string, bigint>) {
  const rank = (s: bigint | null) => (s === null ? -1n : s);
  return backed
    .map((b) => {
      const held = balances.get(b.baseMint) ?? 0n;
      const share = b.floor === null || b.supply === null ? null : floorShare(b.floor, held, b.supply);
      return { pool: b.pool, held, share };
    })
    .filter((b) => b.held > 0n)
    .sort((a, b) => (rank(a.share) === rank(b.share) ? (a.pool < b.pool ? -1 : 1) : rank(a.share) > rank(b.share) ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Reads

/** GET a read-only indexer route; null when it is missing or unavailable. */
async function indexer(path: string) {
  try {
    const r = await fetch(`/api/index/${path}`, { headers: { accept: "application/json" } });
    return r.ok ? ((await r.json()) as unknown) : null;
  } catch {
    return null;
  }
}

/** What the bot has done for one market, or null if the indexer can't say. */
export async function readMarketPayouts(pool: string) {
  return parseMarketPayouts(await indexer(`rewards?pool=${encodeURIComponent(pool)}`));
}

/** What the bot has paid `wallet`; throws if the indexer can't say. */
export async function readWalletPayouts(wallet: string) {
  const rows = parseWalletPayouts(await indexer(`payouts?wallet=${encodeURIComponent(wallet)}`), wallet);
  if (!rows) throw Error("Payout history is unavailable right now.");
  return rows;
}

/** The wallet's balance of every classic SPL token (Sonata's base tokens), in one call. */
export async function readTokenBalances(wallet: string) {
  const { connection, checkNetwork } = await import("../treasury/runtime");
  await checkNetwork();
  const owner = new PublicKey(wallet);
  const { value } = await connection.getTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, "confirmed");
  const holdings = value.flatMap(({ pubkey, account }): TokenHolding[] => {
    try {
      const a = unpackAccount(pubkey, account, TOKEN_PROGRAM_ID);
      return [{ mint: a.mint.toBase58(), owner: a.owner.toBase58(), amount: a.amount, frozen: a.isFrozen }];
    } catch {
      return [];
    }
  });
  return balancesByMint(holdings, owner.toBase58());
}
