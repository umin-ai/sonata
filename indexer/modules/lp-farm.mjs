// "lpFarm" (LP Farm): holders on the curve, liquidity providers after
// graduation. While the market is on its bonding curve (or has graduated with
// no eligible liquidity positions yet) it pays exactly as "holders" does. Once
// graduated it pays the DAMM v2 pool's liquidity providers pro rata to each
// position's UNLOCKED liquidity, to the wallet that holds the position NFT.
// DBC's two graduation positions are permanently locked (no unlocked
// liquidity), so they earn nothing here.
//
// Liquidity counts only as far as it stayed in place: every pass records each
// position's unlocked liquidity (ledger kind 'lp'), whether or not it pays,
// and a paying pass takes one more reading after every market has been paid
// (rewards.mjs). A position's weight is the least it held at any reading since
// the market's last allocation round and now; a position missing from any of
// those readings counts 0. So liquidity added just before a payout, or taken
// out after one and put back before the next, earns nothing for that time.
// (Every reading is taken during a crank pass. An LP whose liquidity is in
// place for every pass, and only then, still counts; readings between passes
// would need a process that runs between them, such as the indexer.)
//
// Dust: a position holding less than 0.01% of the pool's liquidity earns
// nothing, and if the eligible positions together hold less than 0.1% of it,
// the round goes to holders instead, as when there are no LPs. Right after
// graduation nearly all liquidity is DBC's locked positions, so a tiny
// position would otherwise take the whole pot.
//
// Eligible means payable now, as for holders: an LP wallet whose quote account
// is missing or cannot receive, or that still has an unpaid row when the pass
// starts, is left out before the 0.1% check, so it gets no new row and never
// makes the round pay nobody (its earlier rows stay its own). A position whose
// NFT holder is not found yet still counts (its share is held by position).
//
// Payouts go by allocation rounds (payout.mjs payAllocated): a position whose
// NFT holder is not found yet is allocated its share by position address and
// paid once the holder is found, never re-split to the others. Such a row is
// paid to the NFT's holder found later, whatever the position's liquidity by
// then, or, once the position is closed (its NFT burned), to the last holder
// the crank saw. A row whose position has no payable holder (none known, or
// the known one is off curve or one of Sonata's keys) is released after
// POSITION_RELEASE_SECONDS: its amount goes back to what the market owes.
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { CP_AMM_PROGRAM_ID, derivePositionNftAccount, positionByPoolFilter } from "@meteora-ag/cp-amm-sdk";
import { CRANK_KEY, SONATA_VAULT, VAULT_ADMIN, errText, keySet, onCurve, parseKey } from "./common.mjs";
import { amm, graduatedPool, readDammPool, readDbc } from "./meteora.mjs";
import { payAllocated, receivers, rewardShares } from "./payout.mjs";

export const MAX_LPS = 200;
// Position NFTs moved out of their original account are found with
// getTokenLargestAccounts, one call each; at most this many per market per
// pass, positions owed an earlier round's row first, then those never looked
// up (or looked up longest ago), and where each was found is cached, so every
// position is found within a few passes.
export const MAX_NFT_LOOKUPS = 20;
// Position snapshots older than this are dropped (the newest of them is kept).
export const LP_SNAPSHOT_KEEP_SECONDS = 24 * 3600;
// A position needs at least pool liquidity / LP_MIN_POSITION_DIVISOR (0.01%)
// to earn; the eligible positions together need pool liquidity /
// LP_MIN_TOTAL_DIVISOR (0.1%), else holders are paid.
export const LP_MIN_POSITION_DIVISOR = 10_000n;
export const LP_MIN_TOTAL_DIVISOR = 1_000n;
// A position row with no payable holder is released this long after it was allocated.
export const POSITION_RELEASE_SECONDS = 24 * 3600;
const POSITION_DISCRIMINATOR = Buffer.from(amm._program.coder.accounts.accountDiscriminator("position"));

/** The NFT holder from a Token-2022 account that holds exactly one of the NFT, else null. */
export function nftHolder(address, info, nftMint) {
  if (!info) return null;
  try {
    const a = unpackAccount(address, info, TOKEN_2022_PROGRAM_ID);
    return a.mint.equals(nftMint) && a.amount === 1n ? a.owner : null;
  } catch {
    return null;
  }
}

/**
 * Each position's liquidity that stayed in place: the lesser of its unlocked
 * liquidity now and `lows` (position address → the least it held at every
 * reading since the last round, as ledger.heldSince returns it). A position
 * `lows` does not list (missing from some reading, or no reading yet) earns 0.
 */
export function heldLiquidity(positions, lows) {
  return positions.map((p) => {
    const before = lows?.get(p.address.toBase58()) ?? 0n;
    return { ...p, unlocked: p.unlocked < before ? p.unlocked : before };
  });
}

/**
 * LP weights: unlocked liquidity summed per NFT holder. Positions with no
 * unlocked liquidity or less than `minLiquidity`, and holders that are
 * excluded (Sonata's payout bot, the Vault, its admin, `excluded`) or not
 * wallets (off curve), are left out. A position whose holder could not be
 * found this pass (owner null) is weighed on its own, by position address, so
 * its share is allocated to it and paid once its holder is found. Largest
 * first (ties by address), at most `max`; returns { lps, total }.
 */
export function lpWeights(positions, { excluded = [], max = MAX_LPS, minLiquidity = 1n } = {}) {
  const skip = keySet([CRANK_KEY, SONATA_VAULT, VAULT_ADMIN, ...excluded]);
  const byOwner = new Map();
  for (const p of positions) {
    if (p.unlocked <= 0n || p.unlocked < minLiquidity) continue;
    const key = p.owner ? p.owner.toBase58() : `unknown:${p.address.toBase58()}`;
    if (p.owner && (skip.has(key) || !onCurve(p.owner))) continue;
    byOwner.set(key, { owner: p.owner, ...(p.owner ? {} : { position: p.address }), balance: (byOwner.get(key)?.balance ?? 0n) + p.unlocked, key });
  }
  const ranked = [...byOwner.values()]
    .sort((a, b) => (a.balance === b.balance ? (a.key < b.key ? -1 : 1) : a.balance > b.balance ? -1 : 1))
    .slice(0, max);
  return { lps: ranked, total: ranked.reduce((s, l) => s + l.balance, 0n) };
}

/** owed pro rata to weight; a position without a known holder gets its share by position. */
export function lpShares({ lps }, owed) {
  return rewardShares(lps, owed);
}

/** The graduated pool's positions: { address, nftMint, unlocked, owner: null }. */
export async function listPositions({ rpc, connection }, dammPool) {
  const listed = await rpc(() =>
    connection.getProgramAccounts(CP_AMM_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(POSITION_DISCRIMINATOR) } }, positionByPoolFilter(dammPool)],
    }),
  );
  const positions = [];
  for (const { pubkey, account } of listed) {
    try {
      const s = amm._program.coder.accounts.decode("position", Buffer.from(account.data));
      if (!s.pool.equals(dammPool)) continue;
      positions.push({ address: pubkey, nftMint: s.nftMint, unlocked: BigInt(s.unlockedLiquidity.toString()), owner: null });
    } catch {
      // not a position account
    }
  }
  return positions;
}

/**
 * The graduated pool's positions with the NFT holder (owner, or null if not
 * found this pass) of each open position and of each position in `wanted`
 * (addresses owed an earlier round's row, whatever their liquidity now): from
 * DAMM v2's own NFT account, else where an earlier pass found it
 * (ledger.nftHolders), else looked up (at most MAX_NFT_LOOKUPS, `wanted`
 * first, then least recently looked up) and cached. A lookup that finds no
 * account holding the NFT marks the position `nftGone`.
 */
export async function readPositions(ctx, dammPool, { wanted = new Set() } = {}) {
  const { rpc, connection, fetchAll, ledger, dryRun } = ctx;
  const positions = await listPositions(ctx, dammPool);
  const isWanted = (p) => wanted.has(p.address.toBase58());
  const open = positions.filter((p) => p.unlocked > 0n || isWanted(p));
  // Most NFTs stay in the account DAMM v2 minted them to.
  const nftAccounts = open.map((p) => derivePositionNftAccount(p.nftMint));
  const infos = open.length ? await fetchAll(nftAccounts) : [];
  open.forEach((p, i) => (p.owner = nftHolder(nftAccounts[i], infos[i], p.nftMint)));
  const moved = open.filter((p) => !p.owner);
  if (!moved.length) return positions;
  const cache = await ledger.nftHolders(moved.map((p) => p.nftMint.toBase58()));
  const cachedOf = (p) => cache.get(p.nftMint.toBase58());
  const known = moved.filter((p) => cachedOf(p)?.account);
  const knownInfos = known.length ? await fetchAll(known.map((p) => new PublicKey(cachedOf(p).account))) : [];
  known.forEach((p, i) => (p.owner = nftHolder(new PublicKey(cachedOf(p).account), knownInfos[i], p.nftMint)));
  const checkedAt = (p) => cachedOf(p)?.checkedAt ?? -Infinity;
  const unresolved = moved
    .filter((p) => !p.owner)
    .sort((a, b) => Number(isWanted(b)) - Number(isWanted(a)) || checkedAt(a) - checkedAt(b) || (a.address.toBase58() < b.address.toBase58() ? -1 : 1));
  for (const p of unresolved.slice(0, MAX_NFT_LOOKUPS)) {
    let account = null;
    try {
      const { value } = await rpc(() => connection.getTokenLargestAccounts(p.nftMint, "confirmed"));
      const holder = value.find((a) => a.amount === "1");
      if (holder) {
        const [info] = await fetchAll([holder.address]);
        p.owner = nftHolder(holder.address, info, p.nftMint);
        if (p.owner) account = holder.address;
      } else p.nftGone = true;
    } catch (e) {
      p.error = errText(e);
    }
    // Found or not, it moves to the back of the queue.
    if (!dryRun) await ledger.saveNftHolder(p.nftMint.toBase58(), { account: account?.toBase58() ?? null, owner: p.owner?.toBase58() ?? null });
  }
  return positions;
}

/** Records every open position's unlocked liquidity for this pass (unix seconds `at`). */
export async function recordPositions(ledger, pool, at, positions) {
  await ledger.recordSnapshot(pool, "lp", at, positions.filter((p) => p.unlocked > 0n).map((p) => [p.address.toBase58(), p.unlocked]));
  await ledger.pruneSnapshots(pool, "lp", LP_SNAPSHOT_KEEP_SECONDS, at);
}

const passTime = (ctx) => Math.floor((ctx.now ?? Date.now)() / 1000);

const need = (ledger, names, what) => {
  for (const n of names) if (typeof ledger[n] !== "function") throw Error(`ledger has no ${n} (${what}); nothing paid`);
};

/** The graduated DAMM v2 pool: { dammPool, pool (its state, liquidity included) }, or null while the market is on its curve. */
export async function graduated(ctx) {
  const { m, fetchAll } = ctx;
  const [poolInfo, configInfo] = await fetchAll([m.pool, m.config]);
  const dbcState = readDbc(m, poolInfo, configInfo);
  if (!dbcState.graduated) return null;
  const dammPool = graduatedPool(m, dbcState.config);
  const [dammInfo] = await fetchAll([dammPool]);
  return { dammPool, pool: readDammPool(m, dammInfo) };
}

/**
 * Position rows (an LP position allocated its share while its NFT holder was
 * unknown): who each is paid to, and which are released. A position's holder
 * is the NFT's holder found this pass; once the position account is closed or
 * a lookup finds nobody holding its NFT, the last holder the crank saw (saved
 * whenever one is found); otherwise unknown this pass (its rows wait). Rows
 * of a position whose holder is a payable wallet are paid to it and never
 * released. Rows of a position whose holder is none or not payable (off
 * curve, or one of Sonata's keys) are deleted once POSITION_RELEASE_SECONDS
 * old, so their amount is owed to the market again and a later round splits
 * it; each release is logged. Returns resolve(row) for payAllocated.
 */
async function positionRows(ctx, { pool, rows, positions }) {
  const { ledger, dryRun, log, fields, authority, excludedOwners = [] } = ctx;
  const wanted = [...new Set(rows.filter((r) => r.kind === "position").map((r) => r.recipient))];
  const current = new Map(positions.filter((p) => p.owner).map((p) => [p.address.toBase58(), p.owner]));
  if (!wanted.length) return (row) => current.get(row.recipient) ?? null;
  need(ledger, ["positionHolders", "savePositionHolders", "releaseAllocations"], "lp_position_holders");
  const listed = new Map(positions.map((p) => [p.address.toBase58(), p]));
  const last = await ledger.positionHolders(wanted);
  const banned = keySet([CRANK_KEY, SONATA_VAULT, VAULT_ADMIN, authority.publicKey, ...excludedOwners]);
  const payable = (k) => !banned.has(k.toBase58()) && onCurve(k);
  const holders = new Map(), seen = [], release = [];
  for (const position of wanted) {
    const p = listed.get(position);
    // PublicKey; null: nobody can be paid; undefined: not known this pass.
    let holder;
    if (p?.owner) {
      holder = p.owner;
      seen.push([position, p.owner.toBase58()]);
    } else if (!p || p.nftGone) holder = parseKey(last.get(position)?.owner ?? "");
    if (holder) holders.set(position, holder);
    if (holder === null || (holder && !payable(holder))) release.push(position);
  }
  if (!dryRun && seen.length) await ledger.savePositionHolders(pool, seen);
  if (!dryRun && release.length) {
    const released = await ledger.releaseAllocations(pool, { kind: "position", recipients: release, olderThanSeconds: POSITION_RELEASE_SECONDS });
    const byPosition = new Map();
    for (const r of released) byPosition.set(r.recipient, [...(byPosition.get(r.recipient) ?? []), r]);
    for (const [position, list] of byPosition) {
      const holder = holders.get(position);
      log("rewards", {
        pool, model: "lpFarm", action: "release", position, rounds: list.map((r) => r.round).join(","), amount: list.reduce((s, r) => s + r.amount, 0n),
        reason: holder ? `the position's NFT holder ${holder.toBase58()} cannot be paid (off curve or excluded)` : listed.has(position) ? "the position's NFT is held by nobody and no earlier holder is known" : "the position is closed and no holder of it was ever found",
        note: "owed to the market again; a later round splits it",
      });
    }
    if (released.length) fields.released = released.reduce((s, r) => s + r.amount, 0n);
  }
  return (row) => holders.get(row.recipient) ?? current.get(row.recipient) ?? null;
}

export async function runLpFarm(ctx) {
  const { m, fields, ledger, dryRun, excludedOwners = [], authority, result } = ctx;
  const pool = m.pool.toBase58();
  const setStatus = async (status) => {
    fields.paidTo = status;
    if (!dryRun) await ledger.setStatus(pool, status).catch(() => {});
  };
  const holders = async (extra = {}) => {
    await setStatus("holders");
    return ctx.payHolders({ module: "lpFarm", detail: { paidTo: "holders" }, ...extra });
  };
  const g = await graduated(ctx);
  if (!g) return holders();
  const { dammPool } = g;
  need(ledger, ["allocations", "lastRoundAt", "heldSince"], "allocation rounds and LP snapshots");
  const at = passTime(ctx);
  const rows = await ledger.allocations(pool);
  const positions = await readPositions(ctx, dammPool, { wanted: new Set(rows.filter((r) => r.kind === "position").map((r) => r.recipient)) });
  const resolve = await positionRows(ctx, { pool, rows, positions });
  // Every reading since the last round (the one taken at it included), before this pass's.
  const since = await ledger.lastRoundAt(pool, "lpFarm");
  const history = await ledger.heldSince(pool, "lp", since, at, positions.map((p) => p.address.toBase58()));
  if (!dryRun) await recordPositions(ledger, pool, at, positions);
  const liquidity = BigInt(g.pool.liquidity.toString());
  const minTotal = liquidity / LP_MIN_TOTAL_DIVISOR;
  const weights = lpWeights(heldLiquidity(positions, history.lows), { excluded: [authority.publicKey, ...excludedOwners], minLiquidity: liquidity / LP_MIN_POSITION_DIVISOR });
  const detailOf = () => ({ paidTo: "lps", dammPool: dammPool.toBase58() });
  Object.assign(fields, { positions: positions.length, lps: weights.lps.length });
  if (!history.snapshots && positions.some((p) => p.unlocked > 0n)) {
    // The pool's first reading: its LPs earn from the next pass. Earlier rounds are still paid.
    await payAllocated(ctx, { module: "lpFarm", allocate: async () => [], resolve, detailOf, emptyNote: "first LP snapshot taken; LPs earn from the next pass, funds stay owed" });
    return {};
  }
  if (!weights.lps.length) return { ...(await holders({ resolve })), note: "no eligible LP positions; paid holders" };
  // Only LPs who can be paid weigh in, before the floor (as holders are
  // filtered): a wallet that cannot receive (counted in result.skipped) is
  // left out, and so is one with a row still unpaid as the pass starts.
  // `canReceive` is read once; the round below is split among those who can
  // receive and have no unpaid row once earlier rows are paid, a superset of
  // `eligible`, so it always holds at least the floor.
  const known = weights.lps.filter((l) => l.owner);
  const canReceive = known.length ? await receivers(ctx, known.map((l) => l.owner)) : new Set();
  const waiting = new Set(rows.map((r) => r.recipient));
  const payable = (l, unpaid) => !l.owner || (canReceive.has(l.owner.toBase58()) && !unpaid.has(l.owner.toBase58()));
  const eligible = weights.lps.filter((l) => payable(l, waiting));
  const eligibleTotal = eligible.reduce((s, l) => s + l.balance, 0n);
  fields.lps = eligible.length;
  if (!eligible.length) return { ...(await holders({ resolve })), note: "no eligible LP can be paid now (no usable quote account, or an earlier row unpaid); paid holders" };
  if (eligibleTotal < minTotal)
    return { ...(await holders({ resolve })), note: `eligible LP liquidity ${eligibleTotal} is below 0.1% of the pool's ${liquidity}; paid holders` };
  await setStatus("lps");
  const unknown = eligible.filter((l) => !l.owner).length;
  if (unknown) fields.unknownNft = unknown;
  await payAllocated(ctx, {
    module: "lpFarm", emptyNote: "no LP has a quote account", resolve, detailOf,
    allocate: async (amount, { unpaid = new Set() } = {}) => {
      const lps = weights.lps.filter((l) => payable(l, unpaid));
      // Cannot happen (unpaid is within waiting); if it did, funds stay owed.
      if (lps.reduce((s, l) => s + l.balance, 0n) < minTotal) {
        result.note = "the LPs who can be paid hold below 0.1% of the pool; funds stay owed";
        return [];
      }
      return lpShares({ lps }, amount);
    },
  });
  return {};
}

/**
 * A reading of a graduated market's positions without paying it: on a pass
 * that does not pay the market, and after every market of a pass that did
 * (rewards.mjs), so liquidity must stay in place between payouts to count.
 */
export async function observeLpFarm(ctx) {
  if (ctx.dryRun) return;
  const g = await graduated(ctx);
  if (g) await recordPositions(ctx.ledger, ctx.m.pool.toBase58(), passTime(ctx), await listPositions(ctx, g.dammPool));
}
