// Reward token payouts, run by the crank (indexer/crank.mjs) after its normal
// claim/distribute step.
//
// A "Reward token" is a Sonata market whose payout_owner is the crank key. Its
// distribute_split pays the creator share into the crank key's Token-2022
// quote-token account, and the crank passes it on by the market's fee module,
// named in the token's metadata JSON (indexer/modules/fee-model.mjs):
//   holders    pro rata to the base token's holders, in the quote token (default);
//   buyback    buys the token and burns it (modules/buyback.mjs);
//   topBuyers  50/30/20% to the round's top three net buyers (modules/top-buyers.mjs);
//   lpFarm     holders on the curve, DAMM v2 liquidity providers after graduation (modules/lp-farm.mjs);
//   split      fixed wallets by weight (modules/split.mjs);
//   diamond    holders, weighted by how long they have held (modules/diamond.mjs).
// Between the two the crank key holds the funds (custodial for these markets,
// as pump.fun and Ember reward tokens are).
//
// Accounting is per market and the same for every module, although every reward
// market with the same quote mint shares one quote account:
//   owed(pool) = treasury.total_distributed - what the ledger has paid for pool.
// The ledger lives in the indexer's PostgreSQL database (tables created by
// migrate() in indexer/index.mjs):
//   reward_payouts     one row per confirmed transaction (amount = quote atoms
//                      paid or spent; module and detail describe it).
//   reward_pending     a signed transaction, written before it is sent and
//                      counted as paid until its outcome is known. A crash, kill
//                      or timeout between sending and recording can therefore
//                      never make the next pass pay the same recipients twice.
//   market_fee_models  each pool's fee module, read once from its metadata.
//   airdrop_state, airdrop_payouts  the graduation airdrop (modules/airdrop.mjs).
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from "@solana/spl-token";
import { VAULT_ADMIN, errText, toJson } from "./modules/common.mjs";
import { payShares, rewardShares, verdict } from "./modules/payout.mjs";
import { DEFAULT_FEE_MODEL, resolveFeeModels } from "./modules/fee-model.mjs";
import { runBuyback } from "./modules/buyback.mjs";
import { runTopBuyers } from "./modules/top-buyers.mjs";
import { runLpFarm } from "./modules/lp-farm.mjs";
import { runSplit } from "./modules/split.mjs";
import { runDiamond } from "./modules/diamond.mjs";
import { selectHolders } from "./modules/holders.mjs";

export { MAX_RECIPIENTS, MIN_HOLDING_DIVISOR, selectHolders } from "./modules/holders.mjs";

export {
  MAX_TX_BYTES,
  batchTransfers,
  receivable,
  rewardShares,
  settle,
  takeBatch,
  transferItems,
  txBytes,
} from "./modules/payout.mjs";

// 100000 atoms = 0.001 of an 8-decimal quote token.
export const DEFAULT_REWARD_MIN_ATOMS = 100_000n;
const TOKEN_ACCOUNT_SIZE = 165;

/** Quote atoms still owed to a market. Throws if the ledger overpaid. */
export function owedAtoms(totalDistributed, paid) {
  const owed = BigInt(totalDistributed) - BigInt(paid);
  if (owed < 0n) throw Error(`ledger has paid ${paid}, more than the ${totalDistributed} distributed onchain`);
  return owed;
}

/** The ledger on a pg Pool (or anything with pg's query()). Amounts are bigint. */
export function pgLedger(db) {
  const first = async (sql, args) => (await db.query(sql, args)).rows[0];
  return {
    // The tables and columns this crank writes; sonata-indexer's migrate() creates them.
    async ready() {
      return (await first(
        `select to_regclass('reward_payouts') is not null and to_regclass('reward_pending') is not null
                and to_regclass('market_fee_models') is not null
                and to_regclass('airdrop_state') is not null and to_regclass('airdrop_payouts') is not null
                and (select count(*) from information_schema.columns
                      where table_schema = current_schema() and column_name = 'detail'
                        and table_name in ('reward_payouts', 'reward_pending')) = 2 as ok`,
      )).ok;
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
        "select signature, pool, amount::text as amount, recipients, last_valid_block_height::text as lvbh, module from reward_pending order by sent_at",
      );
      return rows.map((r) => ({
        signature: r.signature, pool: r.pool, amount: BigInt(r.amount), recipients: r.recipients,
        lastValidBlockHeight: Number(r.lvbh), module: r.module ?? DEFAULT_FEE_MODEL,
      }));
    },
    async begin({ signature, pool, amount, recipients, lastValidBlockHeight, module = DEFAULT_FEE_MODEL, detail = null }) {
      await db.query(
        "insert into reward_pending (signature, pool, amount, recipients, last_valid_block_height, module, detail) values ($1, $2, $3, $4, $5, $6, $7::jsonb)",
        [signature, pool, amount.toString(), recipients, lastValidBlockHeight, module, toJson(detail)],
      );
    },
    // paid_at is when the transaction was sent; it lands within its blockhash's
    // lifetime (about a minute) or not at all.
    async confirm(signature) {
      await db.query(
        `with moved as (delete from reward_pending where signature = $1 returning *)
         insert into reward_payouts (pool, signature, amount, recipients, paid_at, module, detail)
         select pool, signature, amount, recipients, sent_at, module, detail from moved
         on conflict (signature) do nothing`,
        [signature],
      );
    },
    async drop(signature) {
      await db.query("delete from reward_pending where signature = $1", [signature]);
    },
    // ---- Fee modules ----
    async feeModels(pools) {
      const { rows } = await db.query(
        "select pool, fee_model, uri, config, note from market_fee_models where pool = any($1::text[])",
        [pools],
      );
      return new Map(rows.map((r) => [r.pool, { feeModel: r.fee_model, uri: r.uri, config: r.config, note: r.note }]));
    },
    // The metadata is immutable, so the first reading stands.
    async saveFeeModel({ pool, feeModel, uri = null, config = null, note = null }) {
      await db.query(
        `insert into market_fee_models (pool, fee_model, uri, config, note) values ($1, $2, $3, $4::jsonb, $5)
         on conflict (pool) do nothing`,
        [pool, feeModel, uri, toJson(config), note],
      );
    },
    async setStatus(pool, status) {
      await db.query(
        "update market_fee_models set status = $2, status_at = now() where pool = $1 and status is distinct from $2",
        [pool, status],
      );
    },
    // The end (unix seconds) of the pool's last Top Buyer round, paid or pending.
    async lastRoundEnd(pool) {
      const row = await first(
        `select max(e)::text as round_end from (
           select (detail->>'roundEnd')::bigint as e from reward_payouts where pool = $1 and module = 'topBuyers'
           union all
           select (detail->>'roundEnd')::bigint from reward_pending where pool = $1 and module = 'topBuyers') rounds`,
        [pool],
      );
      return row?.round_end == null ? null : Number(row.round_end);
    },
    // Net quote bought per trader in [start, end), positive only, largest first.
    async buyerNets(pool, start, end, limit = 50) {
      const { rows } = await db.query(
        `select trader, sum(case when side = 'buy' then quote_amount else -quote_amount end)::text as net
           from trades
          where pool = $1 and block_time >= to_timestamp($2) and block_time < to_timestamp($3)
          group by trader
         having sum(case when side = 'buy' then quote_amount else -quote_amount end) > 0
          order by sum(case when side = 'buy' then quote_amount else -quote_amount end) desc, trader
          limit $4`,
        [pool, start, end, limit],
      );
      return rows.map((r) => ({ trader: r.trader, net: BigInt(r.net) }));
    },
    // ---- claim_graduated accounts (modules/graduated.mjs) ----
    async graduatedPositions(pools) {
      const { rows } = await db.query(
        "select pool, damm_pool, position, position_nft_account, token_a_vault, token_b_vault from graduated_positions where pool = any($1::text[])",
        [pools],
      );
      const k = (v) => new PublicKey(v);
      return new Map(rows.map((r) => [r.pool, {
        dammPool: k(r.damm_pool), position: k(r.position), positionNftAccount: k(r.position_nft_account), tokenAVault: k(r.token_a_vault), tokenBVault: k(r.token_b_vault),
      }]));
    },
    async saveGraduatedPosition(pool, g) {
      await db.query(
        `insert into graduated_positions (pool, damm_pool, position, position_nft_account, token_a_vault, token_b_vault)
         values ($1, $2, $3, $4, $5, $6) on conflict (pool) do nothing`,
        [pool, ...[g.dammPool, g.position, g.positionNftAccount, g.tokenAVault, g.tokenBVault].map((x) => x.toBase58())],
      );
    },
    // ---- Graduation airdrop (modules/airdrop.mjs) ----
    async airdropEnsure(pool) {
      await db.query("insert into airdrop_state (pool) values ($1) on conflict (pool) do nothing", [pool]);
    },
    async airdropState(pool) {
      const r = await first(
        `select withdrawn::text, withdraw_signature, withdraw_last_valid_block_height::text as lvbh, snapshot_at, done, sent_at
           from airdrop_state where pool = $1`,
        [pool],
      );
      if (!r) return null;
      return {
        withdrawn: r.withdrawn == null ? null : BigInt(r.withdrawn),
        withdrawSignature: r.withdraw_signature,
        withdrawLastValidBlockHeight: r.lvbh == null ? null : Number(r.lvbh),
        snapshotAt: r.snapshot_at,
        done: r.done,
        sentAt: r.sent_at,
      };
    },
    // The withdrawal's signature, written before it is sent.
    async airdropBeginWithdraw(pool, signature, lastValidBlockHeight) {
      await db.query(
        `update airdrop_state set withdraw_signature = $2, withdraw_last_valid_block_height = $3, updated_at = now()
          where pool = $1 and withdrawn is null`,
        [pool, signature, lastValidBlockHeight],
      );
    },
    async airdropClearWithdraw(pool) {
      await db.query(
        "update airdrop_state set withdraw_signature = null, withdraw_last_valid_block_height = null, updated_at = now() where pool = $1 and withdrawn is null",
        [pool],
      );
    },
    // The first recorded amount stands.
    async airdropWithdrawn(pool, amount, signature) {
      await db.query(
        "update airdrop_state set withdrawn = $2, withdraw_signature = $3, updated_at = now() where pool = $1 and withdrawn is null",
        [pool, amount.toString(), signature],
      );
    },
    // One statement: the rows are written only by the call that takes the snapshot.
    async airdropSnapshot(pool, rows) {
      await db.query(
        `with taken as (
           update airdrop_state set snapshot_at = now(), updated_at = now()
            where pool = $1 and snapshot_at is null and withdrawn is not null returning pool)
         insert into airdrop_payouts (pool, recipient, owner, amount)
         select $1, t.recipient, t.owner, t.amount
           from unnest($2::text[], $3::text[], $4::numeric[]) as t(recipient, owner, amount)
          where exists (select 1 from taken)
         on conflict (pool, recipient) do nothing`,
        [pool, rows.map((r) => r.recipient.toBase58()), rows.map((r) => r.owner.toBase58()), rows.map((r) => r.amount.toString())],
      );
    },
    async airdropRows(pool) {
      const { rows } = await db.query(
        `select recipient, owner, amount::text as atoms, status, signature, last_valid_block_height::text as lvbh
           from airdrop_payouts where pool = $1 order by airdrop_payouts.amount desc, recipient`,
        [pool],
      );
      return rows.map((r) => ({
        recipient: new PublicKey(r.recipient), owner: new PublicKey(r.owner), amount: BigInt(r.atoms), status: r.status,
        signature: r.signature, lastValidBlockHeight: r.lvbh == null ? null : Number(r.lvbh),
      }));
    },
    // Marks unpaid rows pending under one signature, before it is sent; throws unless every row was unpaid.
    async airdropBeginSend(pool, recipients, signature, lastValidBlockHeight) {
      const r = await db.query(
        `update airdrop_payouts set status = 'pending', signature = $3, last_valid_block_height = $4
          where pool = $1 and recipient = any($2::text[]) and status = 'unpaid'`,
        [pool, recipients.map((k) => k.toBase58()), signature, lastValidBlockHeight],
      );
      if (r.rowCount !== recipients.length) throw Error("airdrop rows changed; nothing sent");
    },
    async airdropSettle(pool, signature, status) {
      await db.query(
        status === "sent"
          ? "update airdrop_payouts set status = 'sent', sent_at = now() where pool = $1 and signature = $2 and status = 'pending'"
          : "update airdrop_payouts set status = 'unpaid', signature = null, last_valid_block_height = null where pool = $1 and signature = $2 and status = 'pending'",
        [pool, signature],
      );
    },
    async airdropSkip(pool, recipient, note) {
      await db.query(
        "update airdrop_payouts set status = 'skipped', note = $3 where pool = $1 and recipient = $2 and status = 'unpaid'",
        [pool, recipient.toBase58(), note],
      );
    },
    async airdropDone(pool) {
      await db.query(
        `update airdrop_state set done = true, updated_at = now(),
                sent_at = (select max(sent_at) from airdrop_payouts where pool = $1)
          where pool = $1 and snapshot_at is not null
            and not exists (select 1 from airdrop_payouts where pool = $1 and status in ('unpaid', 'pending'))`,
        [pool],
      );
    },
    // What the airdrop still holds for the pool: withdrawn less what has been sent.
    async airdropReserved(pool) {
      const r = await first(
        `select s.withdrawn::text, s.withdraw_signature,
                coalesce((select sum(amount) from airdrop_payouts where pool = $1 and status = 'sent'), 0)::text as sent
           from airdrop_state s where s.pool = $1`,
        [pool],
      );
      if (!r) return null;
      const withdrawn = r.withdrawn == null ? null : BigInt(r.withdrawn);
      return { withdrawn, amount: withdrawn == null ? 0n : withdrawn - BigInt(r.sent), unknown: withdrawn == null && r.withdraw_signature != null };
    },
    // Each trader's first indexed buy and last indexed sell on the pool, unix seconds.
    async tenure(pool, traders) {
      const { rows } = await db.query(
        `select trader,
                floor(extract(epoch from min(block_time) filter (where side = 'buy')))::bigint::text as first_buy,
                floor(extract(epoch from max(block_time) filter (where side = 'sell')))::bigint::text as last_sell
           from trades where pool = $1 and trader = any($2::text[]) group by trader`,
        [pool, traders],
      );
      const n = (v) => (v == null ? null : Number(v));
      return new Map(rows.map((r) => [r.trader, { firstBuy: n(r.first_buy), lastSell: n(r.last_sell) }]));
    },
  };
}

/** Settles transactions left pending by an earlier pass (crashed, killed or timed out). */
export async function resolvePending({ ledger, connection, rpc, log }) {
  const rows = await ledger.pending();
  const statuses = [];
  for (let i = 0; i < rows.length; i += 256) {
    const signatures = rows.slice(i, i + 256).map((r) => r.signature);
    statuses.push(...(await rpc(() => connection.getSignatureStatuses(signatures, { searchTransactionHistory: true }))).value);
  }
  let height = null;
  for (const [i, row] of rows.entries()) {
    const line = {
      pool: row.pool, ...(row.module && row.module !== DEFAULT_FEE_MODEL ? { model: row.module } : {}),
      sig: row.signature, amount: row.amount, recipients: row.recipients,
    };
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
 * "holders": owed pro rata to the base token's holders (see selectHolders),
 * each to an existing quote account. lpFarm uses it on the curve; diamond
 * passes `weigh` to scale each holder's balance before the shares are taken.
 */
async function payHolders(ctx, { module = DEFAULT_FEE_MODEL, detail = null, weigh = null } = {}) {
  const { m, owed, get, rpc, connection, authority, result } = ctx;
  result.holders = 0;
  result.payable = 0;
  if (!m.baseVault) throw Error("DBC pool not verified this pass; base vault unknown");
  const supply = unpackMint(m.baseMint, get(m.baseMint), TOKEN_PROGRAM_ID).supply;
  const listed = await rpc(() =>
    connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [{ dataSize: TOKEN_ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: m.baseMint.toBase58() } }],
    }),
  );
  const holders = selectHolders(listed, { mint: m.baseMint, supply, excludedAccounts: [m.baseVault, m.treasuryBase], excludedOwners: [authority.publicKey] });
  result.holders = holders.length;
  const weighted = weigh ? await weigh(holders) : holders;
  const detailOf = () => (typeof detail === "function" ? detail() : detail);
  await payShares(ctx, rewardShares(weighted, owed), { module, detailOf, emptyNote: "no payable holders" });
  return {};
}

const MODULES = { holders: payHolders, buyback: runBuyback, topBuyers: runTopBuyers, lpFarm: runLpFarm, split: runSplit, diamond: runDiamond };

/**
 * Pays every reward market what it is owed, by its fee module. `markets` are
 * the crank's market objects whose payoutOwner is `authority`; `rpc`,
 * `simulate` and `blockhash` are the crank pass's helpers, and
 * `readTreasury(info, m)` returns { totalDistributed } from a fresh treasury
 * account. `excluded` are addresses no module ever pays (the Vault; the crank
 * key and the Vault admin are added here). Per-market failures are logged and
 * counted, never thrown. Returns the counts.
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
  excluded = [],
  fetchImpl = globalThis.fetch,
  now = Date.now,
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
    if (!(await ledger.ready()))
      return stopAll("skip", "reward ledger tables missing or out of date; restarting sonata-indexer (setup.sh does) creates them");
    if (!dryRun) await resolvePending({ ledger, connection, rpc, log });
    // Re-read after this pass's distributes: treasury totals and the crank's balances.
    const keys = [...new Map(markets.flatMap((m) => [m.treasury, m.baseMint, m.quoteMint, m.payoutQuote]).map((k) => [k.toBase58(), k])).values()];
    const infos = await fetchAll(keys);
    const byKey = new Map(keys.map((k, i) => [k.toBase58(), infos[i]]));
    get = (k) => byKey.get(k.toBase58()) ?? null;
  } catch (e) {
    return stopAll("fail", `ledger or refresh: ${errText(e)}`);
  }
  // Each market's fee module, read once from its metadata and cached.
  let models, modelError = null;
  try {
    models = await resolveFeeModels({ markets, ledger, fetchAll, fetchImpl, dryRun, log, deadline });
  } catch (e) {
    models = new Map();
    modelError = `fee models: ${errText(e)}`;
  }

  const rows = [];
  for (const m of markets) {
    const pool = m.pool.toBase58();
    const line = { pool, model: models.get(pool)?.feeModel };
    try {
      if (!m.payoutOwner.equals(crank) || !m.payoutQuote.equals(getAssociatedTokenAddressSync(m.quoteMint, crank, false, TOKEN_2022_PROGRAM_ID)))
        throw Error("not a reward market of this crank key");
      const { totalDistributed } = readTreasury(get(m.treasury), m);
      const paid = await ledger.paid(pool);
      rows.push({ m, line: { ...line, distributed: totalDistributed, paid }, owed: owedAtoms(totalDistributed, paid) });
    } catch (e) {
      out.failed++;
      log("rewards", { ...line, action: "fail", reason: errText(e) });
    }
  }
  // One quote account per quote mint holds every such market's owed funds, so
  // it must cover all of them before any is paid: one market's recipients are
  // never paid with another market's funds.
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
    const model = models.get(line.pool);
    if (!model || model.error) {
      out.skipped++;
      log("rewards", { ...line, action: "skip", reason: `fee model not read (${model?.error ?? modelError ?? "unknown"}); read again next pass, funds stay owed` });
      continue;
    }
    const result = { paid: 0n, recipients: 0, txs: 0, simulated: 0, skipped: {} };
    const fields = {};
    const ctx = {
      m, owed, fund, line, model, result, fields, authority, connection, rpc, simulate, blockhash, ledger, get, fetchAll,
      feePayer: feePayerOf(m), dryRun, deadline, pollMs, log, now,
      excludedOwners: [crank, VAULT_ADMIN, m.platformOwner, ...excluded].filter(Boolean),
    };
    ctx.payShares = (shares, opts) => payShares(ctx, shares, opts);
    ctx.payHolders = (opts) => payHolders(ctx, opts);
    let error = null, outcome = {};
    try {
      outcome = (await MODULES[model.feeModel](ctx)) ?? {};
    } catch (e) {
      error = errText(e);
    }
    out.txs += result.txs;
    out.atoms += result.paid;
    out.recipients += result.recipients;
    out.simulated += result.simulated;
    const note = [outcome.note, result.note].filter(Boolean).join("; ") || undefined;
    if (error) out.failed++;
    else if (outcome.skip || (!result.txs && !result.simulated)) out.skipped++;
    const { holders, payable, skipped } = { ...result };
    log("rewards", {
      ...line,
      action: error ? "fail" : outcome.skip ? "skip" : dryRun ? "simulate" : "pay",
      ...fields,
      holders,
      payable,
      noAta: skipped.missing,
      unusable: Object.entries(skipped).filter(([k]) => k !== "missing" && k !== "rejected").reduce((s, [, n]) => s + n, 0) || undefined,
      rejected: skipped.rejected,
      paidNow: result.paid,
      recipients: result.recipients,
      txs: result.txs,
      left: owed - result.paid,
      reason: error ?? outcome.skip ?? undefined,
      note,
    });
  }
  return out;
}
