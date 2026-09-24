// Payout machinery shared by every fee module: transaction sizing, recipient
// checks, batching, and the ledger flow for one signed transaction (written to
// reward_pending before it is sent, settled from the chain afterwards).
// indexer/rewards.mjs re-exports these for its callers and tests.
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
import { errText, sleep } from "./common.mjs";

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
 * are stored with the ledger row. Any send error is settled rather than
 * trusted: a retried send may have landed before.
 */
export async function sendTransaction({ instructions, amount, pool, recipients, module = "holders", detail = null, authority, connection, rpc, blockhash, ledger, pollMs }) {
  const { blockhash: recent, lastValidBlockHeight } = await blockhash();
  const tx = new Transaction({ feePayer: authority.publicKey, blockhash: recent, lastValidBlockHeight }).add(...instructions);
  tx.sign(authority);
  const signature = bs58.encode(tx.signature);
  // Written before sending; if this fails nothing is sent.
  await ledger.begin({ signature, pool, amount, recipients, lastValidBlockHeight, module, detail });
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
 * `detailOf(batch)` is stored with each batch's ledger row.
 */
export async function payShares(ctx, shares, { module = "holders", createMissing = false, detailOf = () => null, emptyNote = "no payable recipients" } = {}) {
  const { m, owed, fund, authority, fetchAll, get, simulate, feePayer, dryRun, deadline, log, line, result } = ctx;
  const crank = authority.publicKey;
  const tag = module === "holders" ? {} : { model: module };
  const { decimals } = unpackMint(m.quoteMint, get(m.quoteMint), TOKEN_2022_PROGRAM_ID);
  const destinations = shares.map((s) => getAssociatedTokenAddressSync(m.quoteMint, s.owner, false, TOKEN_2022_PROGRAM_ID));
  const infos = await fetchAll(destinations);
  const payable = [];
  shares.forEach((s, i) => {
    const why = receivable(destinations[i], infos[i], s.owner, m.quoteMint);
    if (why === "missing" && createMissing) payable.push({ ...s, destination: destinations[i], create: true });
    else if (why) result.skipped[why] = (result.skipped[why] ?? 0) + 1;
    else payable.push({ ...s, destination: destinations[i] });
  });
  result.payable = payable.length;
  if (payable.reduce((s, p) => s + p.amount, 0n) > owed) throw Error("shares exceed what is owed");
  let items = transferItems(payable, { source: m.payoutQuote, mint: m.quoteMint, authority: crank, decimals, payer: feePayer });
  let rejected = 0;
  if (!items.length) result.note = emptyNote;
  while (items.length) {
    if (Date.now() > deadline) {
      result.note = "pass time budget used; the rest stays owed";
      break;
    }
    const batch = takeBatch(items, feePayer);
    const amount = sum(batch);
    if (result.paid + amount > owed || amount > fund.balance) throw Error("payout would exceed what is owed or held");
    const steps = stepsOf(batch);
    const sim = await simulate(steps, feePayer);
    if (sim.err) {
      const index = sim.err?.InstructionError?.[0];
      const item = Number.isInteger(index) ? steps[index]?.item : undefined;
      if (item && rejected < MAX_REJECTED) {
        rejected++;
        result.skipped.rejected = rejected;
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
      break;
    }
    const sent = await sendTransaction({
      instructions: instructionsOf(batch), amount, pool: line.pool, recipients: batch.length, module, detail: detailOf(batch),
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
  return result;
}
