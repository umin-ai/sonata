// Reward token payouts, run by the crank (indexer/crank.mjs) after its normal
// claim/distribute step.
//
// A "Reward token" is a Sonata market whose payout_owner is the crank key. Its
// distribute_split pays the creator share into the crank key's Token-2022
// quote-token account, and the crank passes it on to the base token's holders,
// pro rata, in the quote token. Between the two the crank key holds the holders'
// rewards (custodial for these markets, as pump.fun and Ember reward tokens are).
//
// Accounting is per market, although every reward market with the same quote
// mint shares one quote account:
//   owed(pool) = treasury.total_distributed - what the ledger has paid for pool.
// The ledger lives in the indexer's PostgreSQL database (tables created by
// migrate() in indexer/index.mjs):
//   reward_payouts  one row per confirmed payout transaction.
//   reward_pending  a signed payout transaction, written before it is sent and
//                   counted as paid until its outcome is known. A crash, kill or
//                   timeout between sending and recording can therefore never
//                   make the next pass pay the same holders twice.
import bs58 from "bs58";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getMemoTransfer,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";

export const MAX_TX_BYTES = 1232;
// 100000 atoms = 0.001 of an 8-decimal quote token.
export const DEFAULT_REWARD_MIN_ATOMS = 100_000n;
export const MAX_RECIPIENTS = 200;
// A holder needs at least supply / MIN_HOLDING_DIVISOR (0.01% of supply).
export const MIN_HOLDING_DIVISOR = 10_000n;
// Recipients whose transfer fails simulation are dropped and the batch retried,
// at most this many times per market, so one broken account cannot block a market.
const MAX_REJECTED = 5;
const TOKEN_ACCOUNT_SIZE = 165;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => String(e?.message || e?.name || e).slice(0, 200);
const sum = (items) => items.reduce((s, i) => s + i.payout.amount, 0n);

// Serialized size of a legacy transaction with these instructions.
export function txBytes(instructions, feePayer) {
  const tx = new Transaction().add(...instructions);
  tx.feePayer = feePayer;
  tx.recentBlockhash = PublicKey.default.toBase58();
  const message = tx.compileMessage();
  return 1 + message.header.numRequiredSignatures * 64 + message.serialize().length;
}

/** Quote atoms still owed to a market's holders. Throws if the ledger overpaid. */
export function owedAtoms(totalDistributed, paid) {
  const owed = BigInt(totalDistributed) - BigInt(paid);
  if (owed < 0n) throw Error(`ledger has paid ${paid}, more than the ${totalDistributed} distributed onchain`);
  return owed;
}

/**
 * The holders to pay, from a getProgramAccounts snapshot of the base mint's
 * classic SPL token accounts: balances summed per owner wallet, excluding the
 * given token accounts (the DBC base vault, the treasury's base account) and
 * owners (the crank key), owners off the ed25519 curve (PDAs: pool authorities,
 * DAMM v2 pools, program vaults) and holders of less than 0.01% of supply.
 * Largest first (ties by address), at most `max`.
 */
export function selectHolders(accounts, { mint, supply, excludedAccounts = [], excludedOwners = [], max = MAX_RECIPIENTS }) {
  const skipAccounts = new Set(excludedAccounts.filter(Boolean).map((k) => k.toBase58()));
  const skipOwners = new Set(excludedOwners.map((k) => k.toBase58()));
  const byOwner = new Map();
  for (const { pubkey, account } of accounts) {
    if (skipAccounts.has(pubkey.toBase58())) continue;
    let a;
    try {
      a = unpackAccount(pubkey, account, TOKEN_PROGRAM_ID);
    } catch {
      continue;
    }
    const owner = a.owner.toBase58();
    if (!a.mint.equals(mint) || !a.amount || skipOwners.has(owner) || !PublicKey.isOnCurve(a.owner.toBytes())) continue;
    byOwner.set(owner, { owner: a.owner, balance: (byOwner.get(owner)?.balance ?? 0n) + a.amount });
  }
  if (supply <= 0n) return [];
  return [...byOwner.values()]
    .filter((h) => h.balance * MIN_HOLDING_DIVISOR >= supply)
    .sort((a, b) =>
      a.balance === b.balance
        ? (a.owner.toBase58() < b.owner.toBase58() ? -1 : 1)
        : (a.balance > b.balance ? -1 : 1),
    )
    .slice(0, max);
}

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
 * Why a holder's quote token account cannot receive a plain transfer_checked,
 * or null if it can. "missing" means no account: the crank never pays rent to
 * create one, so that holder's share stays owed.
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

/** One Token-2022 transfer_checked per payout, from the crank's quote account. */
export function transferItems(payouts, { source, mint, authority, decimals }) {
  return payouts.map((payout) => ({
    payout,
    label: `transfer to ${payout.owner.toBase58()}`,
    ix: createTransferCheckedInstruction(source, mint, payout.destination, authority, payout.amount, decimals, [], TOKEN_2022_PROGRAM_ID),
  }));
}

/** The longest prefix of `items` whose transaction fits in maxBytes, measured. */
export function takeBatch(items, feePayer, maxBytes = MAX_TX_BYTES) {
  let n = 0;
  while (n < items.length && txBytes(items.slice(0, n + 1).map((i) => i.ix), feePayer) <= maxBytes) n++;
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

/** The ledger on a pg Pool (or anything with pg's query()). Amounts are bigint. */
export function pgLedger(db) {
  const first = async (sql, args) => (await db.query(sql, args)).rows[0];
  return {
    async ready() {
      return (await first("select to_regclass('reward_payouts') is not null and to_regclass('reward_pending') is not null as ok")).ok;
    },
    // Pending payouts count as paid until their outcome is known.
    async paid(pool) {
      const row = await first(
        `select (coalesce((select sum(amount) from reward_payouts where pool = $1), 0)
               + coalesce((select sum(amount) from reward_pending where pool = $1), 0))::text as paid`,
        [pool],
      );
      return BigInt(row.paid);
    },
    async pending() {
      const { rows } = await db.query(
        "select signature, pool, amount::text as amount, recipients, last_valid_block_height::text as lvbh from reward_pending order by sent_at",
      );
      return rows.map((r) => ({ signature: r.signature, pool: r.pool, amount: BigInt(r.amount), recipients: r.recipients, lastValidBlockHeight: Number(r.lvbh) }));
    },
    async begin({ signature, pool, amount, recipients, lastValidBlockHeight }) {
      await db.query(
        "insert into reward_pending (signature, pool, amount, recipients, last_valid_block_height) values ($1, $2, $3, $4, $5)",
        [signature, pool, amount.toString(), recipients, lastValidBlockHeight],
      );
    },
    // paid_at is when the transaction was sent; it lands within its blockhash's
    // lifetime (about a minute) or not at all.
    async confirm(signature) {
      await db.query(
        `with moved as (delete from reward_pending where signature = $1 returning *)
         insert into reward_payouts (pool, signature, amount, recipients, paid_at)
         select pool, signature, amount, recipients, sent_at from moved
         on conflict (signature) do nothing`,
        [signature],
      );
    },
    async drop(signature) {
      await db.query("delete from reward_pending where signature = $1", [signature]);
    },
  };
}

const verdict = (s) =>
  s?.err
    ? { state: "failed", err: s.err }
    : s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized"
      ? { state: "confirmed" }
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

/** Settles payouts left pending by an earlier pass (crashed, killed or timed out). */
export async function resolvePending({ ledger, connection, rpc, log }) {
  const rows = await ledger.pending();
  const statuses = [];
  for (let i = 0; i < rows.length; i += 256) {
    const signatures = rows.slice(i, i + 256).map((r) => r.signature);
    statuses.push(...(await rpc(() => connection.getSignatureStatuses(signatures, { searchTransactionHistory: true }))).value);
  }
  let height = null;
  for (const [i, row] of rows.entries()) {
    const line = { pool: row.pool, sig: row.signature, amount: row.amount, recipients: row.recipients };
    const known = verdict(statuses[i]);
    if (known?.state === "confirmed") {
      await ledger.confirm(row.signature);
      log("reward", { ...line, result: "paid", note: "confirmed after the pass that sent it" });
    } else if (known) {
      await ledger.drop(row.signature);
      log("reward", { ...line, result: "failed", note: "failed onchain; the amount stays owed" });
    } else if (!statuses[i]) {
      height ??= await rpc(() => connection.getBlockHeight("confirmed"));
      if (height > row.lastValidBlockHeight) {
        await ledger.drop(row.signature);
        log("reward", { ...line, result: "expired", note: "never landed; the amount stays owed" });
      } else log("reward", { ...line, result: "pending" });
    } else log("reward", { ...line, result: "pending" });
  }
}

/**
 * Pays every reward market's holders what it is owed. `markets` are the crank's
 * market objects whose payoutOwner is `authority`; `rpc`, `simulate` and
 * `blockhash` are the crank pass's helpers, and `readTreasury(info, m)` returns
 * { totalDistributed } from a fresh treasury account. Per-market failures are
 * logged and counted, never thrown. Returns the counts.
 */
export async function payRewards({
  markets,
  authority,
  connection,
  rpc,
  simulate,
  blockhash,
  ledger,
  readTreasury,
  feePayerOf = () => authority.publicKey,
  minAtoms = DEFAULT_REWARD_MIN_ATOMS,
  dryRun = false,
  deadline = Infinity,
  pollMs = 2000,
  log,
}) {
  const out = { markets: markets.length, txs: 0, atoms: 0n, recipients: 0, simulated: 0, skipped: 0, failed: 0 };
  const crank = authority.publicKey;
  const stopAll = (action, reason) => {
    out[action === "skip" ? "skipped" : "failed"] = markets.length;
    log("rewards", { action, markets: markets.length, reason });
    return out;
  };
  if (!ledger) return stopAll("skip", "DATABASE_URL not set; reward payouts need the ledger");
  const fetchAll = async (keys) => {
    const infos = [];
    for (let i = 0; i < keys.length; i += 100)
      infos.push(...(await rpc(() => connection.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed"))));
    return infos;
  };
  let get;
  try {
    if (!(await ledger.ready())) return stopAll("skip", "reward ledger tables missing; sonata-indexer creates them when it starts");
    if (!dryRun) await resolvePending({ ledger, connection, rpc, log });
    // Re-read after this pass's distributes: treasury totals and the crank's balances.
    const keys = [...new Map(markets.flatMap((m) => [m.treasury, m.baseMint, m.quoteMint, m.payoutQuote]).map((k) => [k.toBase58(), k])).values()];
    const infos = await fetchAll(keys);
    const byKey = new Map(keys.map((k, i) => [k.toBase58(), infos[i]]));
    get = (k) => byKey.get(k.toBase58()) ?? null;
  } catch (e) {
    return stopAll("fail", `ledger or refresh: ${errText(e)}`);
  }

  const rows = [];
  for (const m of markets) {
    const line = { pool: m.pool.toBase58() };
    try {
      if (!m.payoutOwner.equals(crank) || !m.payoutQuote.equals(getAssociatedTokenAddressSync(m.quoteMint, crank, false, TOKEN_2022_PROGRAM_ID)))
        throw Error("not a reward market of this crank key");
      const { totalDistributed } = readTreasury(get(m.treasury), m);
      const paid = await ledger.paid(line.pool);
      rows.push({ m, line: { ...line, distributed: totalDistributed, paid }, owed: owedAtoms(totalDistributed, paid) });
    } catch (e) {
      out.failed++;
      log("rewards", { ...line, action: "fail", reason: errText(e) });
    }
  }
  // One quote account per quote mint holds every such market's owed rewards, so
  // it must cover all of them before any is paid: one market's holders are never
  // paid with another market's funds.
  const funds = new Map();
  for (const { m, owed } of rows) {
    const key = m.quoteMint.toBase58();
    if (!funds.has(key)) {
      const info = get(m.payoutQuote);
      let fund;
      try {
        const a = info && unpackAccount(m.payoutQuote, info, TOKEN_2022_PROGRAM_ID);
        if (a && (!a.owner.equals(crank) || !a.mint.equals(m.quoteMint))) throw Error("verification failed");
        fund = { balance: a ? a.amount : 0n, owed: 0n };
      } catch (e) {
        fund = { error: `crank quote account: ${errText(e)}`, balance: 0n, owed: 0n };
      }
      funds.set(key, fund);
    }
    funds.get(key).owed += owed;
  }

  for (const r of rows) {
    const { m, owed } = r;
    const fund = funds.get(m.quoteMint.toBase58());
    const line = { ...r.line, owed };
    if (owed === 0n || owed < minAtoms) {
      out.skipped++;
      log("rewards", { ...line, action: "skip", reason: `owed below ${minAtoms}` });
      continue;
    }
    if (fund.error || fund.balance < fund.owed) {
      out.failed++;
      log("rewards", {
        ...line,
        action: "fail",
        reason: fund.error ?? `crank quote balance ${fund.balance} is below the ${fund.owed} owed to this quote token's reward markets; nothing paid`,
      });
      continue;
    }
    if (Date.now() > deadline) {
      out.skipped++;
      log("rewards", { ...line, action: "skip", reason: "pass time budget used; next pass" });
      continue;
    }
    const result = { holders: 0, payable: 0, paid: 0n, recipients: 0, txs: 0, skipped: {} };
    let error = null, note;
    try {
      if (!m.baseVault) throw Error("DBC pool not verified this pass; base vault unknown");
      const supply = unpackMint(m.baseMint, get(m.baseMint), TOKEN_PROGRAM_ID).supply;
      const { decimals } = unpackMint(m.quoteMint, get(m.quoteMint), TOKEN_2022_PROGRAM_ID);
      const listed = await rpc(() =>
        connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
          commitment: "confirmed",
          filters: [{ dataSize: TOKEN_ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: m.baseMint.toBase58() } }],
        }),
      );
      const holders = selectHolders(listed, { mint: m.baseMint, supply, excludedAccounts: [m.baseVault, m.treasuryBase], excludedOwners: [crank] });
      const shares = rewardShares(holders, owed);
      const destinations = shares.map((s) => getAssociatedTokenAddressSync(m.quoteMint, s.owner, false, TOKEN_2022_PROGRAM_ID));
      const infos = await fetchAll(destinations);
      const payable = [];
      shares.forEach((s, i) => {
        const why = receivable(destinations[i], infos[i], s.owner, m.quoteMint);
        if (why) result.skipped[why] = (result.skipped[why] ?? 0) + 1;
        else payable.push({ ...s, destination: destinations[i] });
      });
      Object.assign(result, { holders: holders.length, payable: payable.length });
      if (payable.reduce((s, p) => s + p.amount, 0n) > owed) throw Error("shares exceed what is owed");
      const feePayer = feePayerOf(m);
      let items = transferItems(payable, { source: m.payoutQuote, mint: m.quoteMint, authority: crank, decimals });
      let rejected = 0;
      if (!items.length) note = "no payable holders";
      while (items.length) {
        if (Date.now() > deadline) {
          note = "pass time budget used; the rest stays owed";
          break;
        }
        const batch = takeBatch(items, feePayer);
        const amount = sum(batch);
        if (result.paid + amount > owed || amount > fund.balance) throw Error("payout would exceed what is owed or held");
        const sim = await simulate(batch, feePayer);
        if (sim.err) {
          const index = sim.err?.InstructionError?.[0];
          if (Number.isInteger(index) && batch[index] && rejected < MAX_REJECTED) {
            rejected++;
            result.skipped.rejected = rejected;
            items = items.filter((i) => i !== batch[index]);
            continue;
          }
          const hint = [...(sim.logs ?? [])].reverse().find((l) => /Error|insufficient|failed/i.test(l));
          throw Error(`simulation failed: ${JSON.stringify(sim.err)}${hint ? ` ${hint}` : ""}`);
        }
        const bytes = txBytes(batch.map((i) => i.ix), feePayer);
        if (dryRun) {
          // Later batches depend on this one landing, so only the first is simulated.
          out.simulated++;
          log("reward", { ...line, result: "simulated", amount, recipients: batch.length, bytes, units: sim.unitsConsumed, batches: batchTransfers(items, feePayer).length });
          note = "dry run";
          break;
        }
        const sent = await sendPayout({ batch, amount, pool: line.pool, authority, connection, rpc, blockhash, ledger, pollMs });
        const tx = { pool: line.pool, sig: sent.signature, amount, recipients: batch.length, bytes, note: sent.note };
        if (sent.state !== "confirmed") {
          log("reward", { ...tx, result: sent.state, reason: sent.err ? JSON.stringify(sent.err) : sent.sendError });
          throw Error(sent.state === "unknown"
            ? `payout ${sent.signature} not confirmed yet; it stays pending (counted as paid) until the next pass settles it`
            : `payout ${sent.signature} ${sent.state}; the amount stays owed`);
        }
        log("reward", { ...tx, result: "paid" });
        result.paid += amount;
        result.recipients += batch.length;
        result.txs++;
        fund.balance -= amount;
        fund.owed -= amount;
        out.txs++;
        out.atoms += amount;
        out.recipients += batch.length;
        items = items.slice(batch.length);
      }
    } catch (e) {
      error = errText(e);
    }
    if (error) out.failed++;
    else if (!result.txs && note !== "dry run") out.skipped++;
    log("rewards", {
      ...line,
      action: error ? "fail" : dryRun ? "simulate" : "pay",
      holders: result.holders,
      payable: result.payable,
      noAta: result.skipped.missing,
      unusable: Object.entries(result.skipped).filter(([k]) => k !== "missing" && k !== "rejected").reduce((s, [, n]) => s + n, 0) || undefined,
      rejected: result.skipped.rejected,
      paidNow: result.paid,
      recipients: result.recipients,
      txs: result.txs,
      left: owed - result.paid,
      reason: error ?? undefined,
      note,
    });
  }
  return out;
}

// Signs, records as pending, sends and settles one payout transaction. Any send
// error is settled rather than trusted: a retried send may have landed before.
async function sendPayout({ batch, amount, pool, authority, connection, rpc, blockhash, ledger, pollMs }) {
  const { blockhash: recent, lastValidBlockHeight } = await blockhash();
  const tx = new Transaction({ feePayer: authority.publicKey, blockhash: recent, lastValidBlockHeight }).add(...batch.map((i) => i.ix));
  tx.sign(authority);
  const signature = bs58.encode(tx.signature);
  // Written before sending; if this fails nothing is sent.
  await ledger.begin({ signature, pool, amount, recipients: batch.length, lastValidBlockHeight });
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
