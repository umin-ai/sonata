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
//   reward_allocations each allocation round's recipients and amounts, for the
//                      modules that pay a set of recipients (holders, diamond,
//                      lpFarm, split; modules/payout.mjs payAllocated). An
//                      allocated but unpaid amount stays its recipient's.
//   balance_snapshots, balance_snapshot_rows  the balances each pass saw
//                      (diamond tenure, lpFarm position liquidity, topBuyers
//                      balances at a round's start).
//   lp_nft_holders     where a moved LP position NFT was found.
//   lp_position_holders the last wallet seen holding the NFT of an LP
//                      position that is owed a position row.
// (modules/ledger-schema.mjs creates the last five.)
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { VAULT_ADMIN, errText, toJson } from "./modules/common.mjs";
import { payShares, verdict } from "./modules/payout.mjs";
import { DEFAULT_FEE_MODEL, resolveFeeModels } from "./modules/fee-model.mjs";
import { runBuyback } from "./modules/buyback.mjs";
import { observeTopBuyers, runTopBuyers } from "./modules/top-buyers.mjs";
import { observeLpFarm, runLpFarm } from "./modules/lp-farm.mjs";
import { runSplit } from "./modules/split.mjs";
import { observeDiamond, runDiamond } from "./modules/diamond.mjs";
import { payHolders } from "./modules/holders.mjs";
import { buyerNets as indexedBuyerNets, indexedThrough as indexedThroughOf } from "./modules/indexer-schema.mjs";

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
const LEDGER_TABLES = [
  "reward_payouts", "reward_pending", "market_fee_models", "airdrop_state", "airdrop_payouts",
  "reward_allocations", "balance_snapshots", "balance_snapshot_rows", "lp_nft_holders", "lp_position_holders",
];
const big = (v) => (v == null ? null : BigInt(v));

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
        `select ${LEDGER_TABLES.map((t) => `to_regclass('${t}') is not null`).join(" and ")}
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
    // `allocations` ({ round, recipient, paidTo, creates }): the allocation rows
    // this transaction pays. They are marked pending and the transaction
    // recorded in one statement, and only if every row is still unpaid and
    // they add up to `amount` (the rows are locked while it checks); otherwise
    // nothing is written and this throws.
    async begin({ signature, pool, amount, recipients, lastValidBlockHeight, module = DEFAULT_FEE_MODEL, detail = null, allocations = null }) {
      const row = [signature, pool, amount.toString(), recipients, lastValidBlockHeight, module, toJson(detail)];
      if (!allocations?.length) {
        await db.query(
          "insert into reward_pending (signature, pool, amount, recipients, last_valid_block_height, module, detail) values ($1, $2, $3, $4, $5, $6, $7::jsonb)",
          row,
        );
        return;
      }
      const r = await db.query(
        `with want as (
           select * from unnest($8::int[], $9::text[], $10::text[], $11::boolean[]) as w(round, recipient, paid_to, creates)),
         locked as (
           select a.amount from reward_allocations a join want w on a.round = w.round and a.recipient = w.recipient
            where a.pool = $2 and a.status = 'unpaid' for update of a),
         ok as (select count(*) = $12::bigint and coalesce(sum(amount), 0) = $3::numeric as ok from locked),
         marked as (
           update reward_allocations a set status = 'pending', signature = $1, paid_to = w.paid_to, creates_account = w.creates
             from want w, ok
            where ok.ok and a.pool = $2 and a.round = w.round and a.recipient = w.recipient and a.status = 'unpaid')
         insert into reward_pending (signature, pool, amount, recipients, last_valid_block_height, module, detail)
         select $1, $2, $3::numeric, $4, $5, $6, $7::jsonb from ok where ok.ok
         returning signature`,
        [
          ...row,
          allocations.map((a) => a.round), allocations.map((a) => a.recipient), allocations.map((a) => a.paidTo), allocations.map((a) => Boolean(a.creates)),
          allocations.length,
        ],
      );
      if (r.rowCount !== 1) throw Error("allocation rows changed; nothing sent");
    },
    // paid_at is when the transaction was sent; it lands within its blockhash's
    // lifetime (about a minute) or not at all. Its allocation rows are paid in
    // the same statement.
    async confirm(signature) {
      await db.query(
        `with moved as (delete from reward_pending where signature = $1 returning *),
         settled as (update reward_allocations set status = 'paid', paid_at = now() where signature = $1 and status = 'pending')
         insert into reward_payouts (pool, signature, amount, recipients, paid_at, module, detail)
         select pool, signature, amount, recipients, sent_at, module, detail from moved
         on conflict (signature) do nothing`,
        [signature],
      );
    },
    // Nothing moved: its allocation rows are unpaid again, still their recipients'.
    async drop(signature) {
      await db.query(
        `with gone as (delete from reward_pending where signature = $1)
         update reward_allocations set status = 'unpaid', signature = null, paid_to = null, creates_account = false
          where signature = $1 and status = 'pending'`,
        [signature],
      );
    },
    // ---- Allocation rounds (modules/payout.mjs payAllocated) ----
    // What rounds have allocated to recipients and not paid (or sent) yet.
    async allocatedUnpaid(pool) {
      const row = await first("select coalesce(sum(amount), 0)::text as carried from reward_allocations where pool = $1 and status = 'unpaid'", [pool]);
      return BigInt(row.carried);
    },
    async allocations(pool) {
      const { rows } = await db.query(
        `select round, recipient, kind, module, amount::text as atoms, weight::text as weight
           from reward_allocations where pool = $1 and status = 'unpaid'
          order by reward_allocations.amount desc, round, recipient`,
        [pool],
      );
      return rows.map(allocationRow);
    },
    // One statement: the new round's number and all its rows are written together.
    async allocate(pool, { module, shares }) {
      const { rows } = await db.query(
        `insert into reward_allocations (pool, round, recipient, kind, module, amount, weight)
         select $1, (select coalesce(max(round), 0) + 1 from reward_allocations where pool = $1), t.recipient, t.kind, $2, t.amount, t.weight
           from unnest($3::text[], $4::text[], $5::numeric[], $6::numeric[]) as t(recipient, kind, amount, weight)
         returning round, recipient, kind, module, amount::text as atoms, weight::text as weight`,
        [pool, module, shares.map((s) => s.recipient), shares.map((s) => s.kind), shares.map((s) => s.amount.toString()), shares.map((s) => s.weight?.toString() ?? null)],
      );
      return rows.map(allocationRow);
    },
    // When the pool's newest round of `module` was allocated (unix seconds), or null.
    async lastRoundAt(pool, module) {
      const row = await first(
        "select floor(extract(epoch from max(created_at)))::bigint::text as at from reward_allocations where pool = $1 and module = $2",
        [pool, module],
      );
      return row?.at == null ? null : Number(row.at);
    },
    // Deletes the unpaid rows of `kind` for `recipients` allocated at least
    // olderThanSeconds ago (a pending or paid row is never touched), so their
    // amount is owed to the pool again; returns the deleted rows.
    async releaseAllocations(pool, { kind, recipients, olderThanSeconds }) {
      const { rows } = await db.query(
        `delete from reward_allocations
          where pool = $1 and kind = $2 and status = 'unpaid' and recipient = any($3::text[])
            and created_at <= now() - $4::int * interval '1 second'
          returning round, recipient, kind, module, amount::text as atoms, weight::text as weight`,
        [pool, kind, recipients, olderThanSeconds],
      );
      return rows.map(allocationRow);
    },
    // Wallets whose quote account a payout of this pool created (or is creating).
    async createdAccounts(pool) {
      const { rows } = await db.query(
        `select distinct coalesce(paid_to, recipient) as owner from reward_allocations
          where pool = $1 and creates_account and status in ('pending', 'paid')`,
        [pool],
      );
      return new Set(rows.map((r) => r.owner));
    },
    // ---- Balance snapshots (modules/diamond.mjs, modules/lp-farm.mjs) ----
    // `at` is unix seconds; entries are [holder, amount]. One snapshot per pass.
    async recordSnapshot(pool, kind, at, entries) {
      await db.query(
        `with taken as (
           insert into balance_snapshots (pool, kind, taken_at) values ($1, $2, to_timestamp($3::bigint)) on conflict do nothing returning taken_at)
         insert into balance_snapshot_rows (pool, kind, taken_at, holder, amount)
         select $1, $2, taken.taken_at, t.holder, t.amount from taken, unnest($4::text[], $5::numeric[]) as t(holder, amount)`,
        [pool, kind, at, entries.map(([h]) => h), entries.map(([, a]) => a.toString())],
      );
    },
    // Drops snapshots older than keepSeconds, except the newest of those (a window's start).
    async pruneSnapshots(pool, kind, keepSeconds, at) {
      await db.query(
        `delete from balance_snapshots
          where pool = $1 and kind = $2
            and taken_at < (select max(taken_at) from balance_snapshots where pool = $1 and kind = $2 and taken_at <= to_timestamp($3::bigint - $4::bigint))`,
        [pool, kind, at, keepSeconds],
      );
    },
    // The newest snapshot before `at`: { takenAt, amounts: Map holder → amount }, or null.
    async previousSnapshot(pool, kind, at) {
      const { rows } = await db.query(
        `with s as (select taken_at from balance_snapshots where pool = $1 and kind = $2 and taken_at < to_timestamp($3::bigint) order by taken_at desc limit 1)
         select floor(extract(epoch from s.taken_at))::bigint::text as taken, r.holder, r.amount::text as amount
           from s left join balance_snapshot_rows r on r.pool = $1 and r.kind = $2 and r.taken_at = s.taken_at`,
        [pool, kind, at],
      );
      if (!rows.length) return null;
      return { takenAt: Number(rows[0].taken), amounts: new Map(rows.filter((r) => r.holder != null).map((r) => [r.holder, BigInt(r.amount)])) };
    },
    // For each window d (seconds): the least each holder held over the
    // snapshots before `at`, from the newest one at least d old on, for
    // holders present in every one of them. Map holder → Map(d → least).
    async heldMinimums(pool, kind, holders, at, windows) {
      const { rows } = await db.query(
        `with w as (select unnest($4::bigint[]) as d),
         spans as (
           select w.d, s.since,
                  (select count(*) from balance_snapshots x where x.pool = $1 and x.kind = $2 and x.taken_at >= s.since and x.taken_at < to_timestamp($3::bigint)) as snaps
             from w cross join lateral (
               select max(taken_at) as since from balance_snapshots x where x.pool = $1 and x.kind = $2 and x.taken_at <= to_timestamp($3::bigint - w.d)) s
            where s.since is not null)
         select spans.d::text as d, b.holder, min(b.amount)::text as low
           from spans join balance_snapshot_rows b
             on b.pool = $1 and b.kind = $2 and b.taken_at >= spans.since and b.taken_at < to_timestamp($3::bigint) and b.holder = any($5::text[])
          group by spans.d, spans.snaps, b.holder
         having count(*) = spans.snaps`,
        [pool, kind, at, windows, holders],
      );
      const out = new Map();
      for (const r of rows) (out.get(r.holder) ?? out.set(r.holder, new Map()).get(r.holder)).set(Number(r.d), BigInt(r.low));
      return out;
    },
    // The least each of `holders` held at every snapshot before `at` from the
    // newest one taken at or before `since` (unix seconds; if there is none,
    // or since is null, from the oldest) on: { snapshots (how many), lows
    // (Map holder → least) }. A holder missing from any of them is not in
    // lows.
    async heldSince(pool, kind, since, at, holders) {
      const { rows } = await db.query(
        `with start as (
           select coalesce(
             (select max(taken_at) from balance_snapshots where pool = $1 and kind = $2 and taken_at <= to_timestamp($3::bigint) and taken_at < to_timestamp($4::bigint)),
             (select min(taken_at) from balance_snapshots where pool = $1 and kind = $2)) as since),
         span as (
           select s.taken_at from balance_snapshots s, start
            where s.pool = $1 and s.kind = $2 and s.taken_at >= start.since and s.taken_at < to_timestamp($4::bigint)),
         lows as (
           select r.holder, min(r.amount)::text as low
             from balance_snapshot_rows r join span on r.taken_at = span.taken_at
            where r.pool = $1 and r.kind = $2 and r.holder = any($5::text[])
            group by r.holder
           having count(*) = (select count(*) from span))
         select (select count(*) from span)::int as snaps, lows.holder, lows.low from (select 1) one left join lows on true`,
        [pool, kind, since, at, holders],
      );
      return {
        snapshots: Number(rows[0]?.snaps ?? 0),
        lows: new Map(rows.filter((r) => r.holder != null).map((r) => [r.holder, BigInt(r.low)])),
      };
    },
    // ---- LP position NFT holders (modules/lp-farm.mjs) ----
    // The last wallet seen holding each position's NFT: Map position → { owner, seenAt }.
    async positionHolders(positions) {
      const { rows } = await db.query(
        "select position, owner, floor(extract(epoch from seen_at))::bigint::text as seen from lp_position_holders where position = any($1::text[])",
        [positions],
      );
      return new Map(rows.map((r) => [r.position, { owner: r.owner, seenAt: Number(r.seen) }]));
    },
    // entries: [position, owner] seen this pass.
    async savePositionHolders(pool, entries) {
      await db.query(
        `insert into lp_position_holders (position, pool, owner, seen_at)
         select t.position, $1, t.owner, now() from unnest($2::text[], $3::text[]) as t(position, owner)
         on conflict (position) do update set owner = excluded.owner, seen_at = excluded.seen_at`,
        [pool, entries.map(([p]) => p), entries.map(([, o]) => o)],
      );
    },
    async nftHolders(mints) {
      const { rows } = await db.query(
        "select nft_mint, account, owner, floor(extract(epoch from checked_at))::bigint::text as checked from lp_nft_holders where nft_mint = any($1::text[])",
        [mints],
      );
      return new Map(rows.map((r) => [r.nft_mint, { account: r.account, owner: r.owner, checkedAt: Number(r.checked) }]));
    },
    async saveNftHolder(mint, { account, owner }) {
      await db.query(
        `insert into lp_nft_holders (nft_mint, account, owner, checked_at) values ($1, $2, $3, now())
         on conflict (nft_mint) do update set account = excluded.account, owner = excluded.owner, checked_at = excluded.checked_at`,
        [mint, account, owner],
      );
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
    // Net quote and base bought per trader in [start, end), both venues (the DBC
    // curve and, after graduation, the DAMM v2 pool), positive only, largest first.
    buyerNets: (pool, start, end, limit = 50) => indexedBuyerNets(db, pool, start, end, limit),
    // How far the trade indexer has fully read this market (unix seconds), so a
    // bounty round never closes over trades not indexed yet.
    indexedThrough: (pool) => indexedThroughOf(db, pool),
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
  };
}

const allocationRow = (r) => ({ round: r.round, recipient: r.recipient, kind: r.kind, module: r.module, amount: BigInt(r.atoms), weight: big(r.weight) });

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

const MODULES = { holders: payHolders, buyback: runBuyback, topBuyers: runTopBuyers, lpFarm: runLpFarm, split: runSplit, diamond: runDiamond };
// Modules that keep a per-pass record (balance snapshots) even on a pass that
// does not pay the market, so their history has no gaps.
const OBSERVERS = { diamond: observeDiamond, lpFarm: observeLpFarm, topBuyers: observeTopBuyers };
// Modules whose markets get one more reading after every market of the pass
// has been paid: an LP Farm position must still be in place after its payout
// to count at the next one (modules/lp-farm.mjs).
const REREADS = { lpFarm: observeLpFarm };

/**
 * Pays every reward market what it is owed, by its fee module. `markets` are
 * the crank's market objects whose payoutOwner is `authority`; `rpc`,
 * `simulate` and `blockhash` are the crank pass's helpers, and
 * `readTreasury(info, m)` returns { totalDistributed } from a fresh treasury
 * account. `excluded` are addresses no module ever pays (the Vault; the crank
 * key and the Vault admin are added here). Per-market failures are logged and
 * counted, never thrown. Returns the counts.
 *
 * A module's ctx.owed is what no allocation round holds yet (owed less the
 * rounds' unpaid rows, ctx.owedTotal less ctx.carried), so no module can spend
 * an amount already allocated to someone.
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
  const rereads = [];
  for (const m of markets) {
    const pool = m.pool.toBase58();
    const line = { pool, model: models.get(pool)?.feeModel };
    try {
      if (!m.payoutOwner.equals(crank) || !m.payoutQuote.equals(getAssociatedTokenAddressSync(m.quoteMint, crank, false, TOKEN_2022_PROGRAM_ID)))
        throw Error("not a reward market of this crank key");
      const { totalDistributed } = readTreasury(get(m.treasury), m);
      const paid = await ledger.paid(pool);
      const owed = owedAtoms(totalDistributed, paid);
      // A ledger without allocation rounds holds none (modules that need them then fail, paying nobody).
      const carried = ledger.allocatedUnpaid ? await ledger.allocatedUnpaid(pool) : 0n;
      if (carried > owed) throw Error(`ledger holds ${carried} allocated but unpaid, more than the ${owed} owed`);
      rows.push({ m, line: { ...line, distributed: totalDistributed, paid }, owed, carried });
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
    const { m, owed, carried } = r;
    const fund = funds.get(m.quoteMint.toBase58());
    const line = { ...r.line, owed, ...(carried ? { carried } : {}) };
    const model = models.get(line.pool);
    const result = { paid: 0n, recipients: 0, txs: 0, simulated: 0, skipped: {} };
    const fields = {};
    const ctx = {
      m, owed: owed - carried, owedTotal: owed, carried, minAtoms, fund, line, model, result, fields, authority, connection, rpc, simulate, blockhash, ledger, get, fetchAll,
      feePayer: feePayerOf(m), dryRun, deadline, pollMs, log, now,
      excludedOwners: [crank, VAULT_ADMIN, m.platformOwner, ...excluded].filter(Boolean),
    };
    ctx.payShares = (shares, opts) => payShares(ctx, shares, opts);
    ctx.payHolders = (opts) => payHolders(ctx, opts);
    // A market not paid this pass still gets its snapshot (diamond, lpFarm).
    const observe = async () => {
      const run = model && !model.error && !dryRun && OBSERVERS[model.feeModel];
      if (!run || Date.now() > deadline) return undefined;
      try {
        await run(ctx);
        return undefined;
      } catch (e) {
        return `snapshot failed: ${errText(e)}`;
      }
    };
    if (owed === 0n || owed < minAtoms) {
      out.skipped++;
      log("rewards", { ...line, action: "skip", reason: `owed below ${minAtoms}`, note: await observe() });
      continue;
    }
    if (fund.error || fund.balance < fund.owed) {
      out.failed++;
      log("rewards", {
        ...line,
        action: "fail",
        reason: fund.error ?? `crank quote balance ${fund.balance} is below the ${fund.owed} owed to this quote token's reward markets; nothing paid`,
        note: await observe(),
      });
      continue;
    }
    if (Date.now() > deadline) {
      out.skipped++;
      log("rewards", { ...line, action: "skip", reason: "pass time budget used; next pass" });
      continue;
    }
    if (!model || model.error) {
      out.skipped++;
      log("rewards", { ...line, action: "skip", reason: `fee model not read (${model?.error ?? modelError ?? "unknown"}); read again next pass, funds stay owed` });
      continue;
    }
    let error = null, outcome = {};
    try {
      outcome = (await MODULES[model.feeModel](ctx)) ?? {};
    } catch (e) {
      error = errText(e);
    }
    if (REREADS[model.feeModel] && !dryRun) rereads.push(ctx);
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
  // The extra readings, after every payout of the pass, while its time lasts.
  for (const ctx of rereads) {
    if (Date.now() > deadline) break;
    try {
      await REREADS[ctx.model.feeModel](ctx);
    } catch (e) {
      log("rewards", { pool: ctx.line.pool, model: ctx.model.feeModel, action: "snapshot", result: "failed", reason: errText(e) });
    }
  }
  return out;
}
