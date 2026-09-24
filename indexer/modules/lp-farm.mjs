// "lpFarm" (LP Farm): holders on the curve, liquidity providers after
// graduation. While the market is on its bonding curve (or has graduated with
// no eligible liquidity positions yet) it pays exactly as "holders" does. Once
// graduated it pays the DAMM v2 pool's liquidity providers pro rata to each
// position's UNLOCKED liquidity, to the wallet that holds the position NFT.
// DBC's two graduation positions are permanently locked (no unlocked
// liquidity), so they earn nothing here.
import bs58 from "bs58";
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { CP_AMM_PROGRAM_ID, derivePositionNftAccount, positionByPoolFilter } from "@meteora-ag/cp-amm-sdk";
import { SONATA_VAULT, VAULT_ADMIN, errText, keySet, onCurve } from "./common.mjs";
import { amm, graduatedPool, readDammPool, readDbc } from "./meteora.mjs";
import { rewardShares } from "./payout.mjs";

export const MAX_LPS = 200;
// Position NFTs moved out of their original account are found with
// getTokenLargestAccounts, one call each; at most this many per market per pass.
export const MAX_NFT_LOOKUPS = 20;
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
 * LP weights: unlocked liquidity summed per NFT holder. Positions with no
 * unlocked liquidity, and holders that are excluded (the crank key, the Vault,
 * its admin) or not wallets (off curve), are left out. A position whose holder
 * could not be found this pass (owner null) still counts toward the total, so
 * its share stays owed rather than going to the others. Largest first (ties by
 * address), at most `max`; returns { lps, total }.
 */
export function lpWeights(positions, { excluded = [], max = MAX_LPS } = {}) {
  const skip = keySet([SONATA_VAULT, VAULT_ADMIN, ...excluded]);
  const byOwner = new Map();
  for (const p of positions) {
    if (p.unlocked <= 0n) continue;
    const key = p.owner ? p.owner.toBase58() : `unknown:${p.address.toBase58()}`;
    if (p.owner && (skip.has(key) || !onCurve(p.owner))) continue;
    byOwner.set(key, { owner: p.owner, balance: (byOwner.get(key)?.balance ?? 0n) + p.unlocked, key });
  }
  const ranked = [...byOwner.values()]
    .sort((a, b) => (a.balance === b.balance ? (a.key < b.key ? -1 : 1) : a.balance > b.balance ? -1 : 1))
    .slice(0, max);
  return { lps: ranked, total: ranked.reduce((s, l) => s + l.balance, 0n) };
}

/** owed pro rata to weight over every eligible position; only known holders are paid. */
export function lpShares({ lps }, owed) {
  return rewardShares(lps, owed).filter((s) => s.owner);
}

/** The graduated pool's positions: { address, nftMint, unlocked, owner | null }. */
export async function readPositions({ rpc, connection, fetchAll }, dammPool) {
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
  const open = positions.filter((p) => p.unlocked > 0n);
  // Most NFTs stay in the account DAMM v2 minted them to.
  const nftAccounts = open.map((p) => derivePositionNftAccount(p.nftMint));
  const infos = await fetchAll(nftAccounts);
  open.forEach((p, i) => (p.owner = nftHolder(nftAccounts[i], infos[i], p.nftMint)));
  let lookups = 0;
  for (const p of open) {
    if (p.owner || lookups >= MAX_NFT_LOOKUPS) continue;
    lookups++;
    try {
      const { value } = await rpc(() => connection.getTokenLargestAccounts(p.nftMint, "confirmed"));
      const holder = value.find((a) => a.amount === "1");
      if (holder) {
        const [info] = await fetchAll([holder.address]);
        p.owner = nftHolder(holder.address, info, p.nftMint);
      }
    } catch (e) {
      p.error = errText(e);
    }
  }
  return positions;
}

export async function runLpFarm(ctx) {
  const { m, fetchAll, fields, ledger, dryRun, excludedOwners, authority } = ctx;
  const pool = m.pool.toBase58();
  const setStatus = async (status) => {
    fields.paidTo = status;
    if (!dryRun) await ledger.setStatus(pool, status).catch(() => {});
  };
  const holders = async () => {
    await setStatus("holders");
    return ctx.payHolders({ module: "lpFarm", detail: { paidTo: "holders" } });
  };
  const [poolInfo, configInfo] = await fetchAll([m.pool, m.config]);
  const dbcState = readDbc(m, poolInfo, configInfo);
  if (!dbcState.graduated) return holders();
  const dammPool = graduatedPool(m, dbcState.config);
  const [dammInfo] = await fetchAll([dammPool]);
  readDammPool(m, dammInfo);
  const positions = await readPositions(ctx, dammPool);
  const weights = lpWeights(positions, { excluded: [authority.publicKey, ...excludedOwners] });
  Object.assign(fields, { positions: positions.length, lps: weights.lps.length });
  if (!weights.lps.length) return { ...(await holders()), note: "no eligible LP positions; paid holders" };
  await setStatus("lps");
  const unknown = weights.lps.filter((l) => !l.owner).length;
  if (unknown) fields.unknownNft = unknown;
  await ctx.payShares(lpShares(weights, ctx.owed), {
    module: "lpFarm",
    emptyNote: "no LP has a quote account",
    detailOf: () => ({ paidTo: "lps", dammPool: dammPool.toBase58() }),
  });
  return {};
}
