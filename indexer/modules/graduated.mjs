// After graduation DBC partner fees stop; the Sonata Vault's permanently locked
// DAMM v2 position earns the market's fees instead, and the treasury program's
// claim_graduated pulls them into the treasury (then distribute pays them out
// as before). This finds, per graduated market, what that instruction needs
// besides the market itself: the graduated DAMM v2 pool (derived as
// lib/treasury/runtime.ts readGraduation does), its token vaults, the Vault's
// position in it and the position's NFT account. Finding the position lists
// every position NFT the Vault holds, so results are cached in PostgreSQL
// (graduated_positions); one lookup serves every uncached market of a pass.
import { PublicKey } from "@solana/web3.js";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { DAMM_V2_PROGRAM, SONATA_VAULT, errText } from "./common.mjs";
import { CREATED_POOL, dbcClient, graduatedPool, readDammPool } from "./meteora.mjs";

export const DAMM_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
export const [DAMM_EVENT_AUTHORITY] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DAMM_V2_PROGRAM);

/** Whether the market's DBC pool has graduated to DAMM v2, and its config; null if unreadable. */
export function graduation(poolInfo, configInfo) {
  try {
    const coder = dbcClient.pool.program.coder.accounts;
    const state = coder.decode("virtualPool", Buffer.from(poolInfo.data)).poolState;
    const config = coder.decode("poolConfig", Buffer.from(configInfo.data));
    return { graduated: state.isMigrated !== 0 && state.migrationProgress === CREATED_POOL, config };
  } catch {
    return null;
  }
}

/**
 * The Vault's position in `dammPool` from the SDK's positions of the Vault
 * (CpAmm.getPositionsByUser, as getUserPositionByPool filters it): the most
 * permanently locked one if there are several. Null if none.
 */
export function vaultPosition(positions, dammPool) {
  const inPool = positions.filter((p) => p.positionState.pool.equals(dammPool));
  inPool.sort((a, b) => b.positionState.permanentLockedLiquidity.cmp(a.positionState.permanentLockedLiquidity));
  return inPool[0] ? { position: inPool[0].position, positionNftAccount: inPool[0].positionNftAccount } : null;
}

/**
 * claim_graduated's accounts for every graduated market: Map pool → { dammPool,
 * position, positionNftAccount, tokenAVault, tokenBVault } or { error }. From
 * the cache (`ledger`, optional), else found and cached. `infoOf` gives this
 * pass's pool and config accounts.
 */
export async function graduatedAccounts({ markets, infoOf, connection, rpc, ledger, log = () => {}, positionsOf }) {
  const out = new Map();
  const graduated = [];
  for (const m of markets) {
    const g = graduation(infoOf(m.pool), infoOf(m.config));
    if (g?.graduated) graduated.push({ m, config: g.config });
  }
  if (!graduated.length) return out;
  const pools = graduated.map(({ m }) => m.pool.toBase58());
  let cached = new Map();
  try {
    if (ledger?.graduatedPositions) cached = await ledger.graduatedPositions(pools);
  } catch {
    // no cache this pass (the indexer has not created the table yet)
  }
  const todo = [];
  for (const g of graduated) {
    const hit = cached.get(g.m.pool.toBase58());
    if (hit) out.set(g.m.pool.toBase58(), hit);
    else todo.push(g);
  }
  if (!todo.length) return out;
  let positions, dammInfos;
  const dammPools = todo.map(({ m, config }) => graduatedPool(m, config));
  try {
    // Two RPC calls for all of them: the Vault's position NFTs and their positions.
    positions = await rpc(() => (positionsOf ? positionsOf(SONATA_VAULT) : new CpAmm(connection).getPositionsByUser(SONATA_VAULT)));
    dammInfos = await rpc(() => connection.getMultipleAccountsInfo(dammPools, "confirmed"));
  } catch (e) {
    for (const { m } of todo) out.set(m.pool.toBase58(), { error: `graduated position lookup: ${errText(e)}` });
    return out;
  }
  for (const [i, { m }] of todo.entries()) {
    const pool = m.pool.toBase58();
    try {
      const damm = readDammPool(m, dammInfos[i]);
      const found = vaultPosition(positions, dammPools[i]);
      if (!found) throw Error("the Vault holds no position in the graduated DAMM v2 pool");
      const entry = { dammPool: dammPools[i], ...found, tokenAVault: damm.tokenAVault, tokenBVault: damm.tokenBVault };
      out.set(pool, entry);
      try {
        await ledger?.saveGraduatedPosition?.(pool, entry);
      } catch {
        // used this pass, looked up again next pass
      }
      log("graduated", { pool, dammPool: entry.dammPool.toBase58(), position: entry.position.toBase58(), result: "found" });
    } catch (e) {
      out.set(pool, { error: errText(e) });
    }
  }
  return out;
}
