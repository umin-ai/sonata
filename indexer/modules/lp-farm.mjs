// "lpFarm" (LP Farm): holders on the curve, liquidity providers after
// graduation. While the market is on its bonding curve (or has graduated with
// no eligible liquidity positions yet) it pays exactly as "holders" does. Once
// graduated it pays the DAMM v2 pool's liquidity providers pro rata to each
// position's UNLOCKED liquidity, to the wallet that holds the position NFT.
// DBC's two graduation positions are permanently locked (no unlocked
// liquidity), so they earn nothing here.
//
// Liquidity counts only once it has stayed a whole pass: each pass records
// every position's unlocked liquidity (ledger kind 'lp'), and a position's
// weight is the lesser of now and the previous recorded pass, so liquidity
// added just before a pass and removed after it earns nothing. Payouts go by
// allocation rounds (payout.mjs payAllocated): a position whose NFT holder is
// not found yet is allocated its share by position address and paid once the
// holder is found, never re-split to the others.
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { CP_AMM_PROGRAM_ID, derivePositionNftAccount, positionByPoolFilter } from "@meteora-ag/cp-amm-sdk";
import { CRANK_KEY, SONATA_VAULT, VAULT_ADMIN, errText, keySet, onCurve } from "./common.mjs";
import { amm, graduatedPool, readDammPool, readDbc } from "./meteora.mjs";
import { payAllocated, rewardShares } from "./payout.mjs";

export const MAX_LPS = 200;
// Position NFTs moved out of their original account are found with
// getTokenLargestAccounts, one call each; at most this many per market per
// pass, those never looked up (or looked up longest ago) first, and where each
// was found is cached, so every position is found within a few passes.
export const MAX_NFT_LOOKUPS = 20;
// Position snapshots older than this are dropped (the newest of them is kept).
export const LP_SNAPSHOT_KEEP_SECONDS = 24 * 3600;
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
 * Each position's liquidity that stayed through the last pass: the lesser of
 * its unlocked liquidity now and at the previous recorded pass (`previous`
 * maps position address → unlocked; a position it does not list earns 0).
 */
export function heldLiquidity(positions, previous) {
  return positions.map((p) => {
    const before = previous?.get(p.address.toBase58()) ?? 0n;
    return { ...p, unlocked: p.unlocked < before ? p.unlocked : before };
  });
}

/**
 * LP weights: unlocked liquidity summed per NFT holder. Positions with no
 * unlocked liquidity, and holders that are excluded (Sonata's payout bot, the
 * Vault, its admin, `excluded`) or not wallets (off curve), are left out. A
 * position whose holder could not be found this pass (owner null) is weighed
 * on its own, by position address, so its share is allocated to it and paid
 * once its holder is found. Largest first (ties by address), at most `max`;
 * returns { lps, total }.
 */
export function lpWeights(positions, { excluded = [], max = MAX_LPS } = {}) {
  const skip = keySet([CRANK_KEY, SONATA_VAULT, VAULT_ADMIN, ...excluded]);
  const byOwner = new Map();
  for (const p of positions) {
    if (p.unlocked <= 0n) continue;
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
 * The graduated pool's positions with each open position's NFT holder (owner,
 * or null if not found this pass): from DAMM v2's own NFT account, else where
 * an earlier pass found it (ledger.nftHolders), else looked up (at most
 * MAX_NFT_LOOKUPS, least recently looked up first) and cached.
 */
export async function readPositions(ctx, dammPool) {
  const { rpc, connection, fetchAll, ledger, dryRun } = ctx;
  const positions = await listPositions(ctx, dammPool);
  const open = positions.filter((p) => p.unlocked > 0n);
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
    .sort((a, b) => checkedAt(a) - checkedAt(b) || (a.address.toBase58() < b.address.toBase58() ? -1 : 1));
  for (const p of unresolved.slice(0, MAX_NFT_LOOKUPS)) {
    let account = null;
    try {
      const { value } = await rpc(() => connection.getTokenLargestAccounts(p.nftMint, "confirmed"));
      const holder = value.find((a) => a.amount === "1");
      if (holder) {
        const [info] = await fetchAll([holder.address]);
        p.owner = nftHolder(holder.address, info, p.nftMint);
        if (p.owner) account = holder.address;
      }
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

/** The graduated DAMM v2 pool, or null while the market is on its curve. */
async function graduated(ctx) {
  const { m, fetchAll } = ctx;
  const [poolInfo, configInfo] = await fetchAll([m.pool, m.config]);
  const dbcState = readDbc(m, poolInfo, configInfo);
  if (!dbcState.graduated) return null;
  const dammPool = graduatedPool(m, dbcState.config);
  const [dammInfo] = await fetchAll([dammPool]);
  readDammPool(m, dammInfo);
  return dammPool;
}

export async function runLpFarm(ctx) {
  const { m, fields, ledger, dryRun, excludedOwners = [], authority } = ctx;
  const pool = m.pool.toBase58();
  const setStatus = async (status) => {
    fields.paidTo = status;
    if (!dryRun) await ledger.setStatus(pool, status).catch(() => {});
  };
  const holders = async (extra = {}) => {
    await setStatus("holders");
    return ctx.payHolders({ module: "lpFarm", detail: { paidTo: "holders" }, ...extra });
  };
  const dammPool = await graduated(ctx);
  if (!dammPool) return holders();
  const at = passTime(ctx);
  const positions = await readPositions(ctx, dammPool);
  const previous = await ledger.previousSnapshot(pool, "lp", at);
  if (!dryRun) await recordPositions(ledger, pool, at, positions);
  const weights = lpWeights(heldLiquidity(positions, previous?.amounts), { excluded: [authority.publicKey, ...excludedOwners] });
  // A position row (holder not found when it was allocated) is paid to whoever holds its NFT now.
  const owners = new Map(positions.filter((p) => p.owner).map((p) => [p.address.toBase58(), p.owner]));
  const resolve = (row) => owners.get(row.recipient) ?? null;
  const detailOf = () => ({ paidTo: "lps", dammPool: dammPool.toBase58() });
  Object.assign(fields, { positions: positions.length, lps: weights.lps.length });
  if (!weights.lps.length) {
    if (!previous && positions.some((p) => p.unlocked > 0n)) {
      // The pool's first recorded pass: its LPs earn from the next one. Earlier rounds are still paid.
      await payAllocated(ctx, { module: "lpFarm", allocate: async () => [], resolve, detailOf, emptyNote: "first LP snapshot taken; LPs earn from the next pass, funds stay owed" });
      return {};
    }
    return { ...(await holders({ resolve })), note: "no eligible LP positions; paid holders" };
  }
  await setStatus("lps");
  const unknown = weights.lps.filter((l) => !l.owner).length;
  if (unknown) fields.unknownNft = unknown;
  await payAllocated(ctx, { module: "lpFarm", emptyNote: "no LP has a quote account", resolve, detailOf, allocate: async (amount) => lpShares(weights, amount) });
  return {};
}

/** A pass that does not pay a graduated market still records its positions, so the next pass can weigh them. */
export async function observeLpFarm(ctx) {
  if (ctx.dryRun) return;
  const dammPool = await graduated(ctx);
  if (dammPool) await recordPositions(ctx.ledger, ctx.m.pool.toBase58(), passTime(ctx), await listPositions(ctx, dammPool));
}
