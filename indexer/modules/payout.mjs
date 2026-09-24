// Payout machinery shared by every fee module: transaction sizing, recipient
// checks, batching, the ledger flow for one signed transaction (written to
// reward_pending before it is sent, settled from the chain afterwards) and
// allocation rounds (payAllocated), which keep an unpaid share with its
// recipient across passes. indexer/rewards.mjs re-exports these for its
// callers and tests.
import bs58 from "bs58";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getMemoTransfer,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { CRANK_KEY, SONATA_VAULT, VAULT_ADMIN, errText, keySet, onCurve, parseKey, sleep } from "./common.mjs";

export const MAX_TX_BYTES = 1232;
// Recipients whose transfer fails simulation are dropped and the batch retried,
// at most this many times per market, so one broken account cannot block a market.
export const MAX_REJECTED = 5;
const sum = (items) => items.reduce((s, i) => s + i.payout.amount, 0n);

// Serialized size of a legacy transaction with these instructions.
export function txBytes(instructions, feePayer) {
  const tx = new Transaction().add(...instructions);
  tx.feePayer = feePayer;
  tx.recentBlockhash = PublicKey.default.toBase58();
  const message = tx.compileMessage();
  return 1 + message.header.numRequiredSignatures * 64 + message.serialize().length;
}

/** Every instruction of a batch of payout items, in order (an item may create its account first). */
export const instructionsOf = (items) => items.flatMap((i) => [...(i.pre ?? []), i.ix]);

/**
 * share_i = owed * balance_i / sum of balances, rounded down; zero shares are
 * dropped. The sum never exceeds owed; the rounding remainder stays owed.
 */
export function rewardShares(holders, owed) {
  const total = holders.reduce((s, h) => s + h.balance, 0n);
  if (owed <= 0n || total <= 0n) return [];
  return holders.map((h) => ({ ...h, amount: (owed * h.balance) / total })).filter((s) => s.amount > 0n);
}

// Account extensions that never block an incoming transfer_checked (a memo
// requirement is checked on its own).
const RECEIVING_EXTENSIONS = new Set([ExtensionType.ImmutableOwner, ExtensionType.CpiGuard, ExtensionType.MemoTransfer]);

/**
 * Why a recipient's quote token account cannot receive a plain transfer_checked,
 * or null if it can. "missing" means no account: unless the module creates
 * recipient accounts (split), the crank never pays rent for one, so that share
 * stays owed.
 */
export function receivable(address, info, owner, mint) {
  if (!info) return "missing";
  let a;
  try {
    a = unpackAccount(address, info, TOKEN_2022_PROGRAM_ID);
    if (!a.owner.equals(owner) || !a.mint.equals(mint)) return "invalid";
    if (a.isFrozen) return "frozen";
    if (getExtensionTypes(a.tlvData).some((t) => !RECEIVING_EXTENSIONS.has(t))) return "extension";
    if (getMemoTransfer(a)?.requireIncomingTransferMemos) return "memo";
  } catch {
    return "invalid";
  }
  return null;
}

/**
 * One Token-2022 transfer_checked per payout, from the crank's quote account.
 * A payout marked `create` is preceded by an idempotent creation of its
 * associated token account, paid by `payer`.
 */
export function transferItems(payouts, { source, mint, authority, decimals, payer = authority }) {
  return payouts.map((payout) => ({
    payout,
    label: `transfer to ${payout.owner.toBase58()}`,
    ...(payout.create
      ? { pre: [createAssociatedTokenAccountIdempotentInstruction(payer, payout.destination, payout.owner, mint, TOKEN_2022_PROGRAM_ID)] }
      : {}),
    ix: createTransferCheckedInstruction(source, mint, payout.destination, authority, payout.amount, decimals, [], TOKEN_2022_PROGRAM_ID),
  }));
}

/** The longest prefix of `items` whose transaction fits in maxBytes, measured. */
export function takeBatch(items, feePayer, maxBytes = MAX_TX_BYTES) {
  let n = 0;
  while (n < items.length && txBytes(instructionsOf(items.slice(0, n + 1)), feePayer) <= maxBytes) n++;
  if (!n && items.length) throw Error("one transfer does not fit in a transaction");
  return items.slice(0, n);
}

export function batchTransfers(items, feePayer, maxBytes = MAX_TX_BYTES) {
  const batches = [];
  for (let rest = items; rest.length; ) {
    const batch = takeBatch(rest, feePayer, maxBytes);
    batches.push(batch);
    rest = rest.slice(batch.length);
  }
  return batches;
}

/** A batch as the crank's simulate() takes it: one { label, ix, item } per instruction. */
const stepsOf = (batch) =>
  batch.flatMap((item) => [
    ...(item.pre ?? []).map((ix) => ({ label: `create account for ${item.payout.owner.toBase58()}`, ix, item })),
    { label: item.label, ix: item.ix, item },
  ]);

export const verdict = (s) =>
  s?.err
    ? { state: "failed", err: s.err }
    : s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized"
      ? { state: "confirmed", ...(s.slot != null ? { slot: s.slot } : {}) }
      : null;

/**
 * The outcome of a sent transaction: "confirmed", "failed" (landed with an
 * error, so nothing moved), "expired" (its blockhash expired and it never
 * landed) or "unknown" (still undecided; it stays pending for the next pass).
 */
export async function settle({ connection, rpc, signature, lastValidBlockHeight, pollMs = 2000, polls = 45 }) {
  for (let i = 1; i <= polls; i++) {
    await sleep(pollMs);
    const { value: [status] } = await rpc(() => connection.getSignatureStatuses([signature]));
    const known = verdict(status);
    if (known) return known;
    if (!status && i % 5 === 0 && (await rpc(() => connection.getBlockHeight("confirmed"))) > lastValidBlockHeight) {
      const { value: [last] } = await rpc(() => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }));
      return verdict(last) ?? { state: last ? "unknown" : "expired" };
    }
  }
  return { state: "unknown" };
}

/**
 * Signs, records as pending, sends and settles one transaction. `amount` is the
 * quote atoms it pays (counted as paid while pending); `module` and `detail`
 * are stored with the ledger row. `allocations` ({ round, recipient, paidTo,
 * creates }) are the allocation rows it pays: the ledger marks them pending in
 * the same write, or refuses (and nothing is sent) unless every one is still
 * unpaid and they add up to `amount`. Any send error is settled rather than
 * trusted: a retried send may have landed before.
 */
export async function sendTransaction({ instructions, amount, pool, recipients, module = "holders", detail = null, allocations = null, authority, connection, rpc, blockhash, ledger, pollMs }) {
  const { blockhash: recent, lastValidBlockHeight } = await blockhash();
  const tx = new Transaction({ feePayer: authority.publicKey, blockhash: recent, lastValidBlockHeight }).add(...instructions);
  tx.sign(authority);
  const signature = bs58.encode(tx.signature);
  // Written before sending; if this fails nothing is sent.
  await ledger.begin({ signature, pool, amount, recipients, lastValidBlockHeight, module, detail, ...(allocations?.length ? { allocations } : {}) });
  let sendError;
  try {
    await rpc(() => connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 5 }));
  } catch (e) {
    // Settled below: a rejected transaction expires unlanded and is dropped.
    sendError = String(e?.transactionMessage ?? e?.message ?? e).slice(0, 200);
  }
  const settled = { ...(await settle({ connection, rpc, signature, lastValidBlockHeight, pollMs })), sendError };
  // If the ledger cannot be updated now, the row stays pending (counted as
  // paid) and the next pass settles it from the chain.
  try {
    if (settled.state === "confirmed") await ledger.confirm(signature);
    else if (settled.state !== "unknown") await ledger.drop(signature);
  } catch (e) {
    settled.note = `ledger: ${errText(e)}; stays pending until the next pass`;
  }
  return { signature, ...settled };
}

/** Throws unless a sent transaction confirmed; logs its line either way. */
export function requireConfirmed(sent, tx, log) {
  if (sent.state !== "confirmed") {
    log("reward", { ...tx, result: sent.state, reason: sent.err ? JSON.stringify(sent.err) : sent.sendError });
    throw Error(sent.state === "unknown"
      ? `transaction ${sent.signature} not confirmed yet; it stays pending (counted as paid) until the next pass settles it`
      : `transaction ${sent.signature} ${sent.state}; the amount stays owed`);
  }
  log("reward", { ...tx, result: "paid" });
}

/**
 * Pays `shares` ({ owner, amount }, summing to at most ctx.owed) in the quote
 * token from the crank's quote account, in batches that fit one transaction.
 * Recipients need an existing, usable quote account; with `createMissing` a
 * missing one is created in the same transaction (the crank pays its rent).
 * Progress is kept in ctx.result (paid, recipients, txs, skipped, payable) and
 * ctx.fund, so a failure after some batches still reports what was paid.
 * `detailOf(batch)` is stored with each batch's ledger row. Nothing is kept
 * between passes: a module whose recipients must keep an unpaid share uses
 * payAllocated instead.
 */
export async function payShares(ctx, shares, { module = "holders", createMissing = false, detailOf = () => null, emptyNote = "no payable recipients" } = {}) {
  const { owed, result } = ctx;
  const payable = await payableOf(ctx, shares, { create: createMissing ? () => true : null });
  result.payable = payable.length;
  if (payable.reduce((s, p) => s + p.amount, 0n) > owed) throw Error("shares exceed what is owed");
  if (!payable.length) result.note = emptyNote;
  await sendBatches(ctx, payable, { module, detailOf, limit: owed });
  return result;
}

// Skipped recipients by reason, each counted once per pass (payAllocated may meet one twice).
const count = (result, why, who) => {
  const seen = ((result.skippedWho ??= {})[why] ??= new Set());
  if (seen.has(who)) return;
  seen.add(who);
  result.skipped[why] = (result.skipped[why] ?? 0) + 1;
};

/**
 * The shares ({ owner, amount }) whose quote account can receive, each with
 * that account as `destination`; the others are counted in ctx.result.skipped
 * by reason. `create(owner)`, when given, decides whether a missing account
 * is created in the same transaction (the crank pays its rent); a missing
 * account it declines is counted as "closed".
 */
async function payableOf(ctx, shares, { create = null } = {}) {
  const { m, fetchAll, result } = ctx;
  const destinations = shares.map((s) => getAssociatedTokenAddressSync(m.quoteMint, s.owner, false, TOKEN_2022_PROGRAM_ID));
  const infos = shares.length ? await fetchAll(destinations) : [];
  const payable = [];
  shares.forEach((s, i) => {
    const why = receivable(destinations[i], infos[i], s.owner, m.quoteMint);
    if (why === "missing" && create) {
      if (create(s.owner)) payable.push({ ...s, destination: destinations[i], create: true });
      else count(result, "closed", s.owner.toBase58());
    } else if (why) count(result, why, s.owner.toBase58());
    else payable.push({ ...s, destination: destinations[i] });
  });
  return payable;
}

/**
 * Sends `payable` in batches that fit one transaction, in the order given.
 * `limit` caps what the module may pay this pass (ctx.result.paid included).
 * A recipient whose transfer fails simulation is dropped for this pass (at
 * most MAX_REJECTED per market; one more fails the market). A payout carrying
 * `rows` (allocation rows) has them marked pending with its transaction.
 * Returns true when it stopped before the end: the pass's time budget ran
 * out, or a dry run simulated the first batch.
 */
async function sendBatches(ctx, payable, { module, detailOf, limit }) {
  const { m, fund, authority, get, simulate, feePayer, dryRun, deadline, log, line, result } = ctx;
  const crank = authority.publicKey;
  const tag = module === "holders" ? {} : { model: module };
  const { decimals } = unpackMint(m.quoteMint, get(m.quoteMint), TOKEN_2022_PROGRAM_ID);
  let items = transferItems(payable, { source: m.payoutQuote, mint: m.quoteMint, authority: crank, decimals, payer: feePayer });
  while (items.length) {
    if (Date.now() > deadline) {
      result.note = "pass time budget used; the rest stays owed";
      return true;
    }
    const batch = takeBatch(items, feePayer);
    const amount = sum(batch);
    if (result.paid + amount > limit || amount > fund.balance) throw Error("payout would exceed what is owed or held");
    const steps = stepsOf(batch);
    const sim = await simulate(steps, feePayer);
    if (sim.err) {
      const index = sim.err?.InstructionError?.[0];
      const item = Number.isInteger(index) ? steps[index]?.item : undefined;
      const rejected = result.skipped.rejected ?? 0;
      if (item && rejected < MAX_REJECTED) {
        result.skipped.rejected = rejected + 1;
        items = items.filter((i) => i !== item);
        continue;
      }
      const hint = [...(sim.logs ?? [])].reverse().find((l) => /Error|insufficient|failed/i.test(l));
      throw Error(`simulation failed: ${JSON.stringify(sim.err)}${hint ? ` ${hint}` : ""}`);
    }
    const bytes = txBytes(instructionsOf(batch), feePayer);
    if (dryRun) {
      // Later batches depend on this one landing, so only the first is simulated.
      result.simulated++;
      log("reward", { ...line, ...tag, result: "simulated", amount, recipients: batch.length, bytes, units: sim.unitsConsumed, batches: batchTransfers(items, feePayer).length });
      result.note = "dry run";
      return true;
    }
    const allocations = batch.flatMap((i) =>
      (i.payout.rows ?? []).map((r) => ({ round: r.round, recipient: r.recipient, paidTo: i.payout.owner.toBase58(), creates: Boolean(i.payout.create) })),
    );
    const sent = await sendTransaction({
      instructions: instructionsOf(batch), amount, pool: line.pool, recipients: batch.length, module, detail: detailOf(batch), allocations,
      authority, connection: ctx.connection, rpc: ctx.rpc, blockhash: ctx.blockhash, ledger: ctx.ledger, pollMs: ctx.pollMs,
    });
    requireConfirmed(sent, { pool: line.pool, ...tag, sig: sent.signature, amount, recipients: batch.length, bytes, note: sent.note }, log);
    result.paid += amount;
    result.recipients += batch.length;
    result.txs++;
    fund.balance -= amount;
    fund.owed -= amount;
    items = items.slice(batch.length);
  }
  return false;
}

/** An allocation row's fields for a share: a wallet, or an LP position whose NFT holder is not known yet. */
export const allocationOf = (s) => ({
  recipient: (s.owner ?? s.position).toBase58(),
  kind: s.owner ? "wallet" : "position",
  amount: s.amount,
  weight: s.balance ?? (s.weight == null ? null : BigInt(s.weight)),
});

const largestFirst = (a, b) => (a.amount === b.amount ? (a.key < b.key ? -1 : 1) : a.amount > b.amount ? -1 : 1);

/**
 * Pays unpaid allocation rows, each to its own recipient: a wallet row pays
 * that wallet; a position row pays the position's NFT holder once
 * `resolve(row)` finds one. A recipient's rows from several rounds go in one
 * transfer. A row that cannot be paid now (no or unusable quote account,
 * holder not found, rejected in simulation, or an excluded address) stays
 * unpaid and its recipient's. Returns true when it stopped early (sendBatches).
 */
async function payRows(ctx, rows, { module, detailOf, create, resolve, limit }) {
  const { result, authority, excludedOwners = [] } = ctx;
  const banned = keySet([CRANK_KEY, SONATA_VAULT, VAULT_ADMIN, authority.publicKey, ...excludedOwners]);
  const byOwner = new Map();
  for (const row of rows) {
    const owner = row.kind === "position" ? (resolve?.(row) ?? null) : parseKey(row.recipient);
    if (!owner) {
      count(result, "unresolved", row.recipient);
      continue;
    }
    const key = owner.toBase58();
    if (banned.has(key) || !onCurve(owner)) {
      count(result, "excluded", key);
      continue;
    }
    const seen = byOwner.get(key);
    if (seen) Object.assign(seen, { amount: seen.amount + row.amount, rows: [...seen.rows, row] });
    else byOwner.set(key, { owner, key, amount: row.amount, rows: [row] });
  }
  const payable = await payableOf(ctx, [...byOwner.values()].sort(largestFirst), { create });
  result.payable = (result.payable ?? 0) + payable.length;
  return sendBatches(ctx, payable, { module, detailOf, limit });
}

/**
 * Pays a market by allocation rounds, so no recipient is ever paid another's
 * share. The ledger (reward_allocations) holds each round's recipients and
 * amounts, written once before anything is sent. Each pass:
 *   1. every unpaid row of earlier rounds is paid to its own recipient;
 *   2. only if that did not stop early (time budget, dry run), what no round
 *      holds yet, ctx.owedTotal (or ctx.owed) less the unpaid rows, is
 *      allocated as a new round by `allocate(amount)` (shares of { owner or
 *      position, amount, balance }) when it is at least ctx.minAtoms, and paid.
 * An unpaid row stays its recipient's: a pass that stops early, a send not
 * settled yet (its pending row counts as paid) or a recipient that cannot
 * receive never re-splits it to anyone else. `create(owner)` decides whether
 * a missing quote account is created (payableOf); `resolve(row)` finds a
 * position row's holder. A dry run allocates in memory and writes nothing.
 */
export async function payAllocated(ctx, { module, allocate, detailOf = () => null, emptyNote = "no payable recipients", create = null, resolve = null }) {
  const { ledger, line, result, dryRun } = ctx;
  if (typeof ledger.allocations !== "function") throw Error("ledger has no allocation rounds (reward_allocations); nothing paid");
  const total = ctx.owedTotal ?? ctx.owed;
  const open = await ledger.allocations(line.pool);
  const carried = open.reduce((s, r) => s + r.amount, 0n);
  if (carried > total) throw Error(`ledger holds ${carried} allocated but unpaid, more than the ${total} owed`);
  const opts = { module, detailOf, create, resolve, limit: total };
  if (open.length && (await payRows(ctx, open, opts))) return result;
  const unallocated = total - carried;
  if (unallocated > 0n && unallocated >= (ctx.minAtoms ?? 1n)) {
    const shares = (await allocate(unallocated)).filter((s) => s.amount > 0n);
    if (shares.reduce((s, x) => s + x.amount, 0n) > unallocated) throw Error("shares exceed what is owed");
    if (shares.length) {
      const rows = dryRun
        ? shares.map((s) => ({ ...allocationOf(s), round: 0, module }))
        : await ledger.allocate(line.pool, { module, shares: shares.map(allocationOf) });
      await payRows(ctx, rows, opts);
    }
  }
  if (!result.txs && !result.simulated && !result.note) result.note = emptyNote;
  return result;
}
