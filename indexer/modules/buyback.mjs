// "buyback" (Buyback & burn): what the market is owed buys its own token, and
// every token bought is burned. On the bonding curve the crank key swaps on the
// market's DBC pool; after graduation on the graduated DAMM v2 pool. Both are
// exact-in swaps of at most what is owed, with a minimum out 2% below the SDK's
// quote. The burn (classic SPL Token burn_checked from the crank's base-token
// account) goes in the same transaction: the exact amount the swap delivers is
// read from a simulation first. If the price moves before the transaction lands,
// the burn takes at most what arrived (else the whole transaction fails and
// nothing is spent), and anything still left is burned right after.
import anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { SwapMode } from "@meteora-ag/cp-amm-sdk";
import { errText, simulatedAmount } from "./common.mjs";
import { amm, currentPoint, dbcClient, graduatedPool, readDammPool, readDbc } from "./meteora.mjs";
import { MAX_TX_BYTES, requireConfirmed, sendTransaction, txBytes } from "./payout.mjs";

const { BN } = anchor;
export const BUYBACK_SLIPPAGE_BPS = 200;
export const BASE_DECIMALS = 6;
const QUOTE_DECIMALS = 8;
const bn = (v) => new BN(v.toString());
const big = (v) => BigInt(v.toString());
const sysvarInstructions = [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }];

/**
 * Swapping on the market's DBC pool, from the crank's quote account into its
 * base account, as lib/treasury/runtime.ts prepareTrade quotes and builds a buy.
 */
export function dbcVenue({ m, dbc, crank, crankBase, point }) {
  const { virtualPool, state, config } = dbc;
  if (state.poolType !== 0) throw Error("base token is not a classic SPL token");
  if (config.quoteTokenFlag !== 1) throw Error("quote token is not a Token-2022 token");
  // As the SDK's swap(): rate-limited and first-swap-fee pools read the instructions sysvar.
  const extra = config.poolFees.baseFee.baseFeeMode === 2 || config.enableFirstSwapWithMinFee ? sysvarInstructions : [];
  return {
    kind: "dbc",
    quote(amountIn) {
      const q = dbcClient.pool.swapQuote({
        virtualPool,
        config,
        swapBaseForQuote: false,
        amountIn: bn(amountIn),
        slippageBps: BUYBACK_SLIPPAGE_BPS,
        hasReferral: false,
        eligibleForFirstSwapWithMinFee: false,
        currentPoint: bn(point),
      });
      return { expectedOut: big(q.outputAmount), minOut: big(q.minimumAmountOut) };
    },
    // The curve stops at the migration price: a larger buy does not quote.
    capacityError: (e) => /Insufficient Liquidity/i.test(errText(e)),
    swapIx: (amountIn, minOut) =>
      dbcClient.pool.program.methods
        .swap({ amountIn: bn(amountIn), minimumAmountOut: bn(minOut) })
        .accountsPartial({
          baseMint: m.baseMint,
          quoteMint: m.quoteMint,
          pool: m.pool,
          baseVault: state.baseVault,
          quoteVault: state.quoteVault,
          config: m.config,
          poolAuthority: dbcClient.pool.poolAuthority,
          referralTokenAccount: null,
          inputTokenAccount: m.payoutQuote,
          outputTokenAccount: crankBase,
          payer: crank,
          tokenBaseProgram: TOKEN_PROGRAM_ID,
          tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
        })
        .remainingAccounts(extra)
        .instruction(),
  };
}

/** Swapping on the graduated DAMM v2 pool (quote is token B, base token A). */
export function dammVenue({ m, dammPool, pool, crank, crankBase, point }) {
  const baseFeeMode = Buffer.from(pool.poolFees.baseFee.baseFeeInfo.data).readUInt8(8);
  const extra = baseFeeMode === 2 ? sysvarInstructions : [];
  return {
    kind: "damm",
    quote(amountIn) {
      const q = amm.getQuote2({
        inputTokenMint: m.quoteMint,
        slippage: BUYBACK_SLIPPAGE_BPS,
        poolState: pool,
        currentPoint: bn(point),
        amountIn: bn(amountIn),
        tokenADecimal: BASE_DECIMALS,
        tokenBDecimal: QUOTE_DECIMALS,
        hasReferral: false,
        swapMode: SwapMode.ExactIn,
      });
      return { expectedOut: big(q.outputAmount), minOut: big(q.minimumAmountOut) };
    },
    capacityError: () => false,
    swapIx: (amountIn, minOut) =>
      amm._program.methods
        .swap({ amountIn: bn(amountIn), minimumAmountOut: bn(minOut) })
        .accountsPartial({
          poolAuthority: amm.poolAuthority,
          pool: dammPool,
          payer: crank,
          inputTokenAccount: m.payoutQuote,
          outputTokenAccount: crankBase,
          tokenAVault: pool.tokenAVault,
          tokenBVault: pool.tokenBVault,
          tokenAMint: m.baseMint,
          tokenBMint: m.quoteMint,
          tokenAProgram: TOKEN_PROGRAM_ID,
          tokenBProgram: TOKEN_2022_PROGRAM_ID,
          referralTokenAccount: null,
        })
        .remainingAccounts(extra)
        .instruction(),
  };
}

/**
 * The largest buy of at most `max` quote atoms that the venue quotes: all of it,
 * or, when the curve ends before that, a little under what reaches its end.
 * { amountIn, expectedOut, minOut, capped } or null. Never more than max.
 */
export function largestQuotable(venue, max) {
  if (max <= 0n) return null;
  const attempt = (x) => {
    try {
      return venue.quote(x);
    } catch (e) {
      if (venue.capacityError(e)) return null;
      throw e;
    }
  };
  const full = attempt(max);
  if (full) return { amountIn: max, ...full, capped: false };
  let lo = 0n, hi = max;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (attempt(mid)) lo = mid;
    else hi = mid;
  }
  // 0.1% short of the edge, so onchain rounding cannot tip it over.
  const amountIn = lo - lo / 1000n;
  const q = amountIn > 0n && attempt(amountIn);
  return q ? { amountIn, ...q, capped: true } : null;
}

/** Base atoms the swap delivered: the simulated balance after the probe (which burned `burned`) against the balance before it. */
export const receivedFrom = ({ before, after, burned }) => after - before + burned;

/** The crank's base-token balance for this mint (0 if it has no account). */
export function heldBase(address, info, owner, mint) {
  if (!info) return 0n;
  const a = unpackAccount(address, info, TOKEN_PROGRAM_ID);
  if (!a.owner.equals(owner) || !a.mint.equals(mint)) throw Error("crank base token account verification failed");
  if (a.isFrozen) throw Error("crank base token account is frozen");
  return a.amount;
}

/**
 * Base atoms of this pool that the graduation airdrop (modules/airdrop.mjs)
 * still holds in the crank's base account: { amount }, or { unknown: true }
 * when a leftover withdrawal may have landed without its amount recorded; then
 * nothing is burned but what the buyback itself bought.
 */
export async function airdropReserve(ledger, pool, { airdropMarket, withdrawnFlag }) {
  if (!airdropMarket) return { amount: 0n };
  const r = ledger.airdropReserved ? await ledger.airdropReserved(pool) : null;
  if (!r) return withdrawnFlag ? { unknown: true } : { amount: 0n };
  if (r.unknown || (withdrawnFlag && r.withdrawn == null)) return { unknown: true };
  return { amount: r.amount > 0n ? r.amount : 0n };
}

/** Base atoms a buyback may burn beyond what it buys: what the crank holds, less the airdrop's. */
export const burnable = (held, reserve) => (reserve.unknown ? 0n : held > reserve.amount ? held - reserve.amount : 0n);

/** The instructions of a buyback: [compute budget, create base account?, swap] and the burn builder. */
export async function buybackSteps({ m, venue, spend, minOut, crank, crankBase, feePayer, createBase, decimals = BASE_DECIMALS }) {
  const buy = [
    { label: "compute budget", ix: ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }) },
    ...(createBase
      ? [{ label: "create base account", ix: createAssociatedTokenAccountIdempotentInstruction(feePayer, crankBase, crank, m.baseMint, TOKEN_PROGRAM_ID) }]
      : []),
    { label: `${venue.kind} swap`, ix: await venue.swapIx(spend, minOut) },
  ];
  const burn = (amount) => ({ label: "burn", ix: createBurnCheckedInstruction(crankBase, m.baseMint, crank, amount, decimals, [], TOKEN_PROGRAM_ID) });
  // The burn's amount does not change the size, so this decides it once.
  const together = txBytes([...buy, burn(0n)].map((s) => s.ix), feePayer) <= MAX_TX_BYTES;
  return { buy, burn, together };
}

const simError = (sim, steps) => {
  const index = sim.err?.InstructionError?.[0];
  const where = Number.isInteger(index) ? (steps[index]?.label ?? `instruction ${index}`) : "transaction";
  const hint = [...(sim.logs ?? [])].reverse().find((l) => /Error|insufficient|failed|slippage|exceed/i.test(l));
  return Error(`${where} simulation failed: ${JSON.stringify(sim.err)}${hint ? ` ${hint.replace(/^Program log: /, "")}` : ""}`.slice(0, 300));
};

export async function runBuyback(ctx) {
  const { m, owed, fund, authority, fetchAll, fields, line } = ctx;
  const crank = authority.publicKey;
  const crankBase = getAssociatedTokenAddressSync(m.baseMint, crank, false, TOKEN_PROGRAM_ID);
  const [poolInfo, configInfo, baseInfo, mintInfo] = await fetchAll([m.pool, m.config, crankBase, m.baseMint]);
  const dbc = readDbc(m, poolInfo, configInfo);
  const { decimals } = unpackMint(m.baseMint, mintInfo, TOKEN_PROGRAM_ID);
  if (decimals !== BASE_DECIMALS) throw Error(`base token has ${decimals} decimals, not ${BASE_DECIMALS}`);
  const held = heldBase(crankBase, baseInfo, crank, m.baseMint);
  // A market with the graduation airdrop keeps its withdrawn leftover in the same account.
  const airdropMarket = dbc.config.leftoverReceiver.equals(crank);
  const reserve = await airdropReserve(ctx.ledger, line.pool, { airdropMarket, withdrawnFlag: dbc.state.isWithdrawLeftover !== 0 });
  const before = burnable(held, reserve);
  if (held > before) fields.airdropHeld = reserve.unknown ? "unknown" : held - before;
  let venue;
  if (!dbc.migrated) {
    if (dbc.curveComplete) return { skip: "curve complete, waiting for graduation; funds stay owed" };
    venue = dbcVenue({ m, dbc, crank, crankBase, point: await currentPoint(ctx, dbc.config.activationType) });
  } else {
    if (!dbc.graduated) return { skip: "graduating; the DAMM v2 pool is not ready, funds stay owed" };
    const dammPool = graduatedPool(m, dbc.config);
    const [dammInfo] = await fetchAll([dammPool]);
    const dammState = readDammPool(m, dammInfo);
    venue = dammVenue({ m, dammPool, pool: dammState, crank, crankBase, point: await currentPoint(ctx, dammState.activationType) });
  }
  fields.venue = venue.kind;
  const pick = largestQuotable(venue, owed);
  if (!pick || pick.minOut <= 0n) return { skip: "owed is too small to buy any tokens" };
  if (pick.amountIn > owed || pick.amountIn > fund.balance) throw Error("buyback would spend more than is owed or held");
  return executeBuyback(ctx, { venue, spend: pick.amountIn, minOut: pick.minOut, capped: pick.capped, held, before, createBase: !baseInfo, crankBase, decimals, airdropMarket });
}

/**
 * Buys with `spend` quote atoms on `venue` and burns everything bought, plus
 * `before`: base tokens a previous buyback left in the crank's account. `held`
 * is the account's whole balance (it may also hold airdrop tokens, which are
 * never burned); it defaults to `before`.
 */
export async function executeBuyback(ctx, { venue, spend, minOut, capped = false, before, held = before, createBase, crankBase, decimals = BASE_DECIMALS, airdropMarket = false }) {
  const { m, owed, fund, authority, simulate, feePayer, dryRun, log, line, fields, result, rpc, connection } = ctx;
  const pool = line.pool;
  const crank = authority.publicKey;
  if (spend > owed || spend > fund.balance) throw Error("buyback would spend more than is owed or held");
  if (before > held) throw Error("buyback would burn more than the crank holds");
  Object.assign(fields, { spend, minOut, capped: capped ? 1 : undefined, leftover: before || undefined });
  const { buy, burn, together } = await buybackSteps({ m, venue, spend, minOut, crank, crankBase, feePayer, createBase, decimals });
  // Probe: what the swap delivers at the current pool state.
  const probeBurn = together ? before + minOut : 0n;
  const probeSteps = together ? [...buy, burn(probeBurn)] : buy;
  const probe = await simulate(probeSteps, feePayer, { accounts: [crankBase] });
  if (probe.err) throw simError(probe, probeSteps);
  const after = simulatedAmount(probe.accounts?.[0], { owner: crank, mint: m.baseMint, program: TOKEN_PROGRAM_ID });
  const received = receivedFrom({ before: held, after, burned: probeBurn });
  if (received < minOut) throw Error(`swap would deliver ${received}, below its minimum ${minOut}`);
  fields.received = received;

  const steps = together ? [...buy, burn(before + received)] : buy;
  const bytes = txBytes(steps.map((s) => s.ix), feePayer);
  const sim = together ? await simulate(steps, feePayer) : probe;
  if (sim.err) throw simError(sim, steps);
  const burnNow = together ? before + received : 0n;
  const tx = { pool, model: "buyback", venue: venue.kind, spent: spend, burned: burnNow, bytes };
  if (dryRun) {
    result.simulated++;
    log("reward", { ...tx, result: "simulated", received, units: sim.unitsConsumed, burnAfter: together ? undefined : 1 });
    return { note: "dry run" };
  }
  const send = (instructions, amount, detail) =>
    sendTransaction({
      instructions, amount, pool, recipients: 0, module: "buyback", detail,
      authority, connection, rpc, blockhash: ctx.blockhash, ledger: ctx.ledger, pollMs: ctx.pollMs,
    });
  const sent = await send(steps.map((s) => s.ix), spend, { venue: venue.kind, spent: spend, minOut, received, burned: burnNow, leftover: before });
  requireConfirmed(sent, { ...tx, sig: sent.signature, note: sent.note }, log);
  result.paid += spend;
  result.txs++;
  fund.balance -= spend;
  fund.owed -= spend;
  fields.burned = burnNow;

  // Whatever is still in the crank's base account (the burn did not share the
  // transaction, or the swap landed at a better price than simulated) is burned now.
  let left;
  try {
    const [info, poolInfo] = await rpc(() => connection.getMultipleAccountsInfo([crankBase, m.pool], { commitment: "confirmed", ...(sent.slot ? { minContextSlot: sent.slot } : {}) }));
    // The airdrop's tokens are never burned: re-read in case a withdrawal just landed.
    const withdrawnFlag = airdropMarket && dbcClient.pool.program.coder.accounts.decode("virtualPool", Buffer.from(poolInfo.data)).poolState.isWithdrawLeftover !== 0;
    const reserve = await airdropReserve(ctx.ledger, pool, { airdropMarket, withdrawnFlag });
    left = burnable(heldBase(crankBase, info, crank, m.baseMint), reserve);
  } catch (e) {
    return { note: `leftover not read (${errText(e)}); burned with the next buyback` };
  }
  if (left <= 0n) return {};
  const burnOnly = [burn(left)];
  const again = await simulate(burnOnly, feePayer);
  if (again.err) return { note: `leftover ${left} not burned now (${simError(again, burnOnly).message}); burned with the next buyback` };
  const sentBurn = await send(burnOnly.map((s) => s.ix), 0n, { burned: left, burnOnly: true });
  const burnLine = { pool, model: "buyback", sig: sentBurn.signature, burned: left, bytes: txBytes(burnOnly.map((s) => s.ix), feePayer), note: sentBurn.note };
  if (sentBurn.state !== "confirmed") {
    log("reward", { ...burnLine, result: sentBurn.state, reason: sentBurn.err ? JSON.stringify(sentBurn.err) : sentBurn.sendError });
    return { note: `leftover ${left} burn ${sentBurn.state}; burned with the next buyback if still held` };
  }
  log("reward", { ...burnLine, result: "paid" });
  result.txs++;
  fields.burned = burnNow + left;
  return {};
}
