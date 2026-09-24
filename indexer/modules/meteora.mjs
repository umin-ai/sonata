// Meteora reads for the fee modules: the market's DBC pool and config, and its
// graduated DAMM v2 pool, decoded with the SDKs' own coders and checked against
// the market. The SDK clients here only build instructions and decode
// accounts; they never send through their connection.
import { Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DAMM_V2_PROGRAM_ID,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  deriveDammV2PoolAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CP_AMM_PROGRAM_ID, CpAmm, getTokenProgram } from "@meteora-ag/cp-amm-sdk";
import { SONATA_VAULT } from "./common.mjs";

const offline = new Connection("http://127.0.0.1:1");
export const dbcClient = new DynamicBondingCurveClient(offline, "confirmed");
export const amm = new CpAmm(offline);
if (!DAMM_V2_PROGRAM_ID.equals(CP_AMM_PROGRAM_ID)) throw Error("DBC migrates to an unexpected DAMM v2 program.");
// DBC MigrationProgress: 3 = CreatedPool, the DAMM v2 pool and positions exist.
export const CREATED_POOL = 3;

/**
 * The market's DBC pool and config: { virtualPool (as the SDK's swapQuote takes
 * it), state (its poolState), config, graduated, curveComplete }. Throws unless
 * both are DBC accounts of this market.
 */
export function readDbc(m, poolInfo, configInfo) {
  if (!poolInfo?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) || !configInfo?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
    throw Error("pool or config is not owned by Meteora DBC");
  const coder = dbcClient.pool.program.coder.accounts;
  const virtualPool = coder.decode("virtualPool", Buffer.from(poolInfo.data));
  const config = coder.decode("poolConfig", Buffer.from(configInfo.data));
  const state = virtualPool.poolState;
  if (!state.config.equals(m.config) || !state.baseMint.equals(m.baseMint) || !config.quoteMint.equals(m.quoteMint) || !config.feeClaimer.equals(SONATA_VAULT))
    throw Error("pool configuration does not match this market");
  return {
    virtualPool,
    state,
    config,
    migrated: state.isMigrated !== 0,
    graduated: state.isMigrated !== 0 && state.migrationProgress === CREATED_POOL,
    curveComplete: BigInt(state.quoteReserve.toString()) >= BigInt(config.migrationQuoteThreshold.toString()),
  };
}

/** The DAMM v2 pool DBC creates at graduation, derived as lib/treasury/runtime.ts readGraduation does. */
export function graduatedPool(m, config) {
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (!dammConfig) throw Error("unsupported migration fee option");
  return deriveDammV2PoolAddress(dammConfig, m.baseMint, m.quoteMint);
}

/** The graduated DAMM v2 pool's state. Throws unless it holds this market's tokens (base as A, quote as B). */
export function readDammPool(m, info) {
  if (!info?.owner.equals(CP_AMM_PROGRAM_ID)) throw Error("graduated DAMM v2 pool not found");
  const pool = amm._program.coder.accounts.decode("pool", Buffer.from(info.data));
  if (!pool.tokenAMint.equals(m.baseMint) || !pool.tokenBMint.equals(m.quoteMint))
    throw Error("DAMM v2 pool does not hold this market's tokens");
  if (!getTokenProgram(pool.tokenAFlag).equals(TOKEN_PROGRAM_ID) || !getTokenProgram(pool.tokenBFlag).equals(TOKEN_2022_PROGRAM_ID))
    throw Error("DAMM v2 pool uses unexpected token programs");
  return pool;
}

/** The current slot, or unix time for timestamp-activated pools (activationType 1), as the SDKs' getCurrentPoint. */
export async function currentPoint({ rpc, connection }, activationType) {
  const slot = await rpc(() => connection.getSlot("confirmed"));
  if (activationType === 0) return slot;
  try {
    const time = await rpc(() => connection.getBlockTime(slot));
    if (time) return time;
  } catch {
    // a slot's time can lag behind it; the local clock is within seconds
  }
  return Math.floor(Date.now() / 1000);
}

