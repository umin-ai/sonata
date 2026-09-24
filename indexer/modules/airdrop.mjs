// Graduation Airdrop: a job, not a fee module, for any Sonata market whose DBC
// config names the crank key as leftover receiver (a launch with the airdrop
// sets leftover = 5% of supply). Once the pool has graduated the crank:
//   1. withdraws the leftover (DBC withdraw_leftover; permissionless, it pays
//      the leftover receiver's base-token account) and records exactly the
//      amount that transaction moved, read from its token balances;
//   2. snapshots the holders once (the holders module's rules: wallets only,
//      not the crank, the Vault or its admin, at least 0.01% of supply, top 200)
//      and writes one airdrop_payouts row per holder: withdrawn × balance ÷ total,
//      rounded down, to the token account the holder already holds it in;
//   3. pays the unpaid rows, classic SPL transfer_checked, about 20 per
//      transaction. A row is marked pending with its signature before sending
//      and settled from the chain, so a crash mid-airdrop resumes without paying
//      anyone twice.
// Base tokens are kept apart by pool and by job: the airdrop only ever sends
// its rows (never more than it withdrew), and the buyback module never burns
// what the airdrop still holds (airdropReserved).
import bs58 from "bs58";
import { ComputeBudgetProgram, PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { DBC_PROGRAM, SONATA_VAULT, VAULT_ADMIN, errText, simulatedAmount } from "./common.mjs";
import { dbcClient, readDbc } from "./meteora.mjs";
import { MAX_REJECTED, rewardShares, settle, takeBatch, txBytes, verdict } from "./payout.mjs";
import { selectHolders } from "./holders.mjs";

export const AIRDROP_DECIMALS = 6;
const TOKEN_ACCOUNT_SIZE = 165;
// A withdrawal made by someone else is looked for among this many of the crank
// base account's transactions, once.
const MAX_WITHDRAW_SEARCH = 20;
const WITHDRAW_LEFTOVER = Buffer.from(dbcClient.pool.program.idl.instructions.find((i) => i.name === "withdrawLeftover").discriminator);

/** The airdrop rows: withdrawn × balance ÷ total per holder, rounded down, to the holder's largest token account. */
export function airdropShares(holders, withdrawn) {
  return rewardShares(holders, withdrawn).map((s) => ({ recipient: s.account, owner: s.owner, amount: s.amount }));
}

// Account keys of a getTransaction response, legacy or v0.
function keysOf(tx) {
  const msg = tx.transaction.message;
  const keys = (msg.staticAccountKeys ?? msg.accountKeys).map((k) => new PublicKey(k.toBase58?.() ?? k));
  const loaded = tx.meta?.loadedAddresses;
  return loaded ? [...keys, ...loaded.writable.map((k) => new PublicKey(k)), ...loaded.readonly.map((k) => new PublicKey(k))] : keys;
}
function instructionsOfTx(tx, keys) {
  const msg = tx.transaction.message;
  const top = (msg.compiledInstructions ?? msg.instructions).map((ix) => ({
    program: keys[ix.programIdIndex],
    accounts: (ix.accountKeyIndexes ?? ix.accounts).map((i) => keys[i]),
    data: Buffer.from(typeof ix.data === "string" ? bs58.decode(ix.data) : ix.data),
  }));
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((g) =>
    g.instructions.map((ix) => ({ program: keys[ix.programIdIndex], accounts: ix.accounts.map((i) => keys[i]), data: Buffer.from(bs58.decode(ix.data)) })),
  );
  return [...top, ...inner];
}

/**
 * Base atoms a successful withdraw_leftover transaction of `pool` moved into
 * `crankBase`, from its token balances; null if it is not one.
 */
export function withdrawnFromTransaction(tx, { pool, crankBase }) {
  if (!tx?.meta || tx.meta.err) return null;
  const keys = keysOf(tx);
  const withdraw = instructionsOfTx(tx, keys).some(
    (ix) => ix.program?.equals(DBC_PROGRAM) && ix.data.subarray(0, 8).equals(WITHDRAW_LEFTOVER) && ix.accounts[2]?.equals(pool) && ix.accounts[3]?.equals(crankBase),
  );
  if (!withdraw) return null;
  const index = keys.findIndex((k) => k.equals(crankBase));
  const amount = (list) => BigInt(list?.find((b) => b.accountIndex === index)?.uiTokenAmount.amount ?? 0);
  const moved = amount(tx.meta.postTokenBalances) - amount(tx.meta.preTokenBalances);
  return moved > 0n ? moved : null;
}

/** The withdraw_leftover instruction, as the DBC SDK's migration.withdrawLeftover({ pool, payer }) builds it. */
export function withdrawLeftoverIx({ m, dbc, crank, crankBase }) {
  if (dbc.config.tokenType !== 0) throw Error("base token is not a classic SPL token");
  return dbcClient.pool.program.methods
    .withdrawLeftover()
    .accountsPartial({
      poolAuthority: dbcClient.pool.poolAuthority,
      config: m.config,
      virtualPool: m.pool,
      tokenBaseAccount: crankBase,
      baseVault: dbc.state.baseVault,
      baseMint: m.baseMint,
      leftoverReceiver: crank,
      tokenBaseProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/** Why a snapshot row's token account cannot take the transfer now, or null. */
export function airdropReceivable(row, info, mint) {
  if (!info) return "account closed";
  try {
    const a = unpackAccount(row.recipient, info, TOKEN_PROGRAM_ID);
    if (!a.mint.equals(mint) || !a.owner.equals(row.owner)) return "account changed owner or mint";
    if (a.isFrozen) return "account frozen";
  } catch {
    return "not a token account";
  }
  return null;
}

/**
 * Checks the rows against what was withdrawn: throws unless every row, paid or
 * not, sums to at most `withdrawn`. Returns the amounts by status.
 */
export function airdropTotals(rows, withdrawn) {
  const t = { sent: 0n, pending: 0n, unpaid: 0n, skipped: 0n, all: 0n };
  for (const r of rows) {
    t[r.status] += r.amount;
    t.all += r.amount;
  }
  if (t.all > withdrawn) throw Error(`airdrop rows total ${t.all}, more than the ${withdrawn} withdrawn; nothing sent`);
  return t;
}

/** Runs the airdrop job for every market this pass. Per-market failures are logged and counted. */
export async function runAirdrops(job) {
  const { markets, infoOf, authority, log } = job;
  const crank = authority.publicKey;
  const out = { markets: 0, txs: 0, atoms: 0n, failed: 0 };
  for (const m of markets) {
    let dbc;
    try {
      dbc = readDbc(m, infoOf(m.pool), infoOf(m.config));
    } catch {
      continue; // the market's own line already reports an unreadable pool
    }
    if (!dbc.config.leftoverReceiver.equals(crank)) continue;
    out.markets++;
    const line = { pool: m.pool.toBase58() };
    try {
      await airdropMarket({ ...job, m, dbc, line, out });
    } catch (e) {
      out.failed++;
      log("airdrop", { ...line, action: "fail", reason: errText(e) });
    }
  }
  return out;
}

async function airdropMarket({ m, dbc, line, out, authority, connection, rpc, simulate, blockhash, ledger, dryRun, deadline = Infinity, pollMs = 2000, log, feePayerOf, excluded = [] }) {
  const crank = authority.publicKey;
  const pool = line.pool;
  const crankBase = getAssociatedTokenAddressSync(m.baseMint, crank, false, TOKEN_PROGRAM_ID);
  const fetchAll = async (keys) => rpc(() => connection.getMultipleAccountsInfo(keys, "confirmed"));
  if (!dryRun) await ledger.airdropEnsure(pool);
  let state = (await ledger.airdropState(pool)) ?? {};
  if (!dbc.migrated) return log("airdrop", { ...line, action: "wait", reason: "not graduated" });
  if (state.done) return;
  if (Date.now() > deadline) return log("airdrop", { ...line, action: "skip", reason: "pass time budget used; next pass" });
  const feePayer = feePayerOf(m);

  // 1. The withdrawn amount: from our recorded withdrawal, from one made by
  // someone else, or by withdrawing now.
  if (state.withdrawn == null && state.withdrawSignature) {
    const { value: [status] } = await rpc(() => connection.getSignatureStatuses([state.withdrawSignature], { searchTransactionHistory: true }));
    const known = verdict(status);
    if (known?.state === "confirmed") {
      const amount = await withdrawnBy(state.withdrawSignature, { m, crankBase, connection, rpc });
      if (amount == null) return log("airdrop", { ...line, action: "wait", sig: state.withdrawSignature, reason: "withdrawal confirmed; amount not readable yet" });
      await ledger.airdropWithdrawn(pool, amount, state.withdrawSignature);
    } else if (known || (!status && (await rpc(() => connection.getBlockHeight("confirmed"))) > state.withdrawLastValidBlockHeight)) {
      await ledger.airdropClearWithdraw(pool);
      log("airdrop", { ...line, sig: state.withdrawSignature, result: known ? "failed" : "expired", note: "withdrawal did not land; tried again" });
    } else return log("airdrop", { ...line, action: "wait", sig: state.withdrawSignature, reason: "withdrawal pending" });
    state = (await ledger.airdropState(pool)) ?? {};
  }
  if (state.withdrawn == null) {
    if (dbc.state.isWithdrawLeftover !== 0) {
      // Withdrawn by someone else (the instruction is permissionless); the tokens are in the crank's account.
      const found = await findWithdrawal({ m, crankBase, connection, rpc });
      if (!found) throw Error("leftover already withdrawn by a transaction the crank cannot find; set airdrop_state.withdrawn and withdraw_signature by hand");
      if (!dryRun) await ledger.airdropWithdrawn(pool, found.amount, found.signature);
      state = dryRun ? { ...state, withdrawn: found.amount } : await ledger.airdropState(pool);
    } else {
      const [baseInfo] = await fetchAll([crankBase]);
      const steps = [
        { label: "compute budget", ix: ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }) },
        ...(baseInfo ? [] : [{ label: "create base account", ix: createAssociatedTokenAccountIdempotentInstruction(feePayer, crankBase, crank, m.baseMint, TOKEN_PROGRAM_ID) }]),
        { label: "withdraw leftover", ix: await withdrawLeftoverIx({ m, dbc, crank, crankBase }) },
      ];
      const sim = await simulate(steps, feePayer, { accounts: [crankBase] });
      if (sim.err) throw Error(`withdraw leftover simulation failed: ${JSON.stringify(sim.err)}`);
      const before = baseInfo ? unpackAccount(crankBase, baseInfo, TOKEN_PROGRAM_ID).amount : 0n;
      const preview = simulatedAmount(sim.accounts?.[0], { owner: crank, mint: m.baseMint, program: TOKEN_PROGRAM_ID }) - before;
      if (dryRun) return log("airdrop", { ...line, action: "withdraw", result: "simulated", amount: preview, units: sim.unitsConsumed });
      const { blockhash: recent, lastValidBlockHeight } = await blockhash();
      const tx = new Transaction({ feePayer: crank, blockhash: recent, lastValidBlockHeight }).add(...steps.map((s) => s.ix));
      tx.sign(authority);
      const signature = bs58.encode(tx.signature);
      // Recorded before sending: a crash after this resumes from the signature.
      await ledger.airdropBeginWithdraw(pool, signature, lastValidBlockHeight);
      try {
        await rpc(() => connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 5 }));
      } catch {
        // settled below
      }
      const settled = await settle({ connection, rpc, signature, lastValidBlockHeight, pollMs });
      if (settled.state === "unknown") return log("airdrop", { ...line, action: "withdraw", sig: signature, result: "pending" });
      if (settled.state !== "confirmed") {
        await ledger.airdropClearWithdraw(pool);
        throw Error(`withdraw leftover ${signature} ${settled.state}`);
      }
      out.txs++;
      const amount = await withdrawnBy(signature, { m, crankBase, connection, rpc });
      if (amount == null) return log("airdrop", { ...line, action: "withdraw", sig: signature, result: "paid", note: "amount read next pass" });
      await ledger.airdropWithdrawn(pool, amount, signature);
      log("airdrop", { ...line, action: "withdraw", sig: signature, amount, result: "paid" });
      state = await ledger.airdropState(pool);
    }
  }
  const withdrawn = state.withdrawn;

  // 2. The holder snapshot, taken once.
  let rows = await ledger.airdropRows(pool);
  if (!state.snapshotAt) {
    const [mintInfo] = await fetchAll([m.baseMint]);
    const { supply, decimals } = unpackMint(m.baseMint, mintInfo, TOKEN_PROGRAM_ID);
    if (decimals !== AIRDROP_DECIMALS) throw Error(`base token has ${decimals} decimals, not ${AIRDROP_DECIMALS}`);
    const listed = await rpc(() =>
      connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
        commitment: "confirmed",
        filters: [{ dataSize: TOKEN_ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: m.baseMint.toBase58() } }],
      }),
    );
    const holders = selectHolders(listed, {
      mint: m.baseMint,
      supply,
      excludedAccounts: [dbc.state.baseVault, m.treasuryBase, crankBase],
      excludedOwners: [crank, SONATA_VAULT, VAULT_ADMIN, m.platformOwner, ...excluded].filter(Boolean),
    });
    const snapshot = airdropShares(holders, withdrawn).map((r) => ({ ...r, status: "unpaid" }));
    airdropTotals(snapshot, withdrawn);
    if (dryRun) rows = snapshot;
    else {
      await ledger.airdropSnapshot(pool, snapshot);
      rows = await ledger.airdropRows(pool);
    }
    log("airdrop", { ...line, action: "snapshot", holders: holders.length, amount: withdrawn, rows: snapshot.length, result: dryRun ? "simulated" : "taken" });
  }

  // 3. Settle rows left pending by an earlier pass, then pay what is unpaid.
  const pending = rows.filter((r) => r.status === "pending");
  if (pending.length) {
    const signatures = [...new Set(pending.map((r) => r.signature))];
    const { value } = await rpc(() => connection.getSignatureStatuses(signatures, { searchTransactionHistory: true }));
    let height = null;
    for (const [i, signature] of signatures.entries()) {
      const known = verdict(value[i]);
      const lvbh = pending.find((r) => r.signature === signature).lastValidBlockHeight;
      if (known?.state === "confirmed") await ledger.airdropSettle(pool, signature, "sent");
      else if (known) await ledger.airdropSettle(pool, signature, "unpaid");
      else if (!value[i] && (height ??= await rpc(() => connection.getBlockHeight("confirmed"))) > lvbh) await ledger.airdropSettle(pool, signature, "unpaid");
    }
    rows = await ledger.airdropRows(pool);
  }
  const totals = airdropTotals(rows, withdrawn);
  const unpaid = rows.filter((r) => r.status === "unpaid");
  if (!unpaid.length) {
    if (!totals.pending && !dryRun) {
      await ledger.airdropDone(pool);
      log("airdrop", { ...line, action: "done", amount: totals.sent, recipients: rows.filter((r) => r.status === "sent").length, skipped: rows.filter((r) => r.status === "skipped").length || undefined });
    }
    return;
  }
  const [baseInfo, mintInfo] = await fetchAll([crankBase, m.baseMint]);
  const held = baseInfo ? unpackAccount(crankBase, baseInfo, TOKEN_PROGRAM_ID).amount : 0n;
  if (held < totals.unpaid + totals.pending)
    throw Error(`crank holds ${held} base atoms, below the ${totals.unpaid + totals.pending} still to airdrop; nothing sent`);
  const { decimals } = unpackMint(m.baseMint, mintInfo, TOKEN_PROGRAM_ID);
  const infos = await fetchAll(unpaid.map((r) => r.recipient));
  let items = [];
  for (const [i, r] of unpaid.entries()) {
    const why = airdropReceivable(r, infos[i], m.baseMint);
    if (why) {
      if (!dryRun) await ledger.airdropSkip(pool, r.recipient, why);
      log("airdrop", { ...line, recipient: r.recipient.toBase58(), amount: r.amount, result: "skipped", reason: why });
      continue;
    }
    items.push({
      row: r,
      payout: { owner: r.owner, amount: r.amount },
      label: `airdrop to ${r.recipient.toBase58()}`,
      ix: createTransferCheckedInstruction(crankBase, m.baseMint, r.recipient, crank, r.amount, decimals, [], TOKEN_PROGRAM_ID),
    });
  }
  let sent = totals.sent + totals.pending, rejected = 0;
  while (items.length) {
    if (Date.now() > deadline) return log("airdrop", { ...line, action: "skip", reason: "pass time budget used; the rest next pass" });
    const batch = takeBatch(items, feePayer);
    const amount = batch.reduce((s, i) => s + i.row.amount, 0n);
    if (sent + amount > withdrawn) throw Error("airdrop would send more than was withdrawn");
    const steps = batch.map((i) => ({ label: i.label, ix: i.ix, item: i }));
    const sim = await simulate(steps, feePayer);
    if (sim.err) {
      const index = sim.err?.InstructionError?.[0];
      const item = Number.isInteger(index) ? steps[index]?.item : undefined;
      if (item && rejected < MAX_REJECTED) {
        rejected++;
        if (!dryRun) await ledger.airdropSkip(pool, item.row.recipient, "transfer rejected");
        items = items.filter((i) => i !== item);
        continue;
      }
      throw Error(`airdrop simulation failed: ${JSON.stringify(sim.err)}`);
    }
    const bytes = txBytes(batch.map((i) => i.ix), feePayer);
    if (dryRun) return log("airdrop", { ...line, action: "send", result: "simulated", amount, recipients: batch.length, bytes, units: sim.unitsConsumed });
    const { blockhash: recent, lastValidBlockHeight } = await blockhash();
    const tx = new Transaction({ feePayer: crank, blockhash: recent, lastValidBlockHeight }).add(...batch.map((i) => i.ix));
    tx.sign(authority);
    const signature = bs58.encode(tx.signature);
    // Marked pending before sending: a crash resumes from the signature, never pays again.
    await ledger.airdropBeginSend(pool, batch.map((i) => i.row.recipient), signature, lastValidBlockHeight);
    try {
      await rpc(() => connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 5 }));
    } catch {
      // settled below
    }
    const settled = await settle({ connection, rpc, signature, lastValidBlockHeight, pollMs });
    const txLine = { ...line, action: "send", sig: signature, amount, recipients: batch.length, bytes };
    if (settled.state === "unknown") {
      log("airdrop", { ...txLine, result: "pending" });
      return;
    }
    await ledger.airdropSettle(pool, signature, settled.state === "confirmed" ? "sent" : "unpaid");
    if (settled.state !== "confirmed") throw Error(`airdrop ${signature} ${settled.state}; its recipients stay unpaid`);
    log("airdrop", { ...txLine, result: "paid" });
    out.txs++;
    out.atoms += amount;
    sent += amount;
    items = items.slice(batch.length);
  }
  const after = await ledger.airdropRows(pool);
  if (!after.some((r) => r.status === "unpaid" || r.status === "pending")) {
    await ledger.airdropDone(pool);
    log("airdrop", { ...line, action: "done", amount: airdropTotals(after, withdrawn).sent, recipients: after.filter((r) => r.status === "sent").length });
  }
}

async function withdrawnBy(signature, { m, crankBase, connection, rpc }) {
  const tx = await rpc(() => connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
  return withdrawnFromTransaction(tx, { pool: m.pool, crankBase });
}

// A withdraw_leftover sent by someone else, among the crank base account's first transactions.
async function findWithdrawal({ m, crankBase, connection, rpc }) {
  const signatures = await rpc(() => connection.getSignaturesForAddress(crankBase, { limit: 1000 }, "confirmed"));
  for (const { signature, err } of signatures.reverse().slice(0, MAX_WITHDRAW_SEARCH)) {
    if (err) continue;
    const amount = await withdrawnBy(signature, { m, crankBase, connection, rpc });
    if (amount != null) return { signature, amount };
  }
  return null;
}
