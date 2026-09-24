// Ledger tables the crank's own modules need beyond indexer/rewards.mjs
// pgLedger, and their queries. migrateCrank() runs at the end of the indexer's
// migrate() (indexer/index.mjs; idempotent, as the rest of it), and the crank
// wraps its pgLedger with crankLedger() (indexer/crank.mjs).

/** Creates the crank's extra tables if missing. `db` is a pg Pool or client. */
export async function migrateCrank(db) {
  await db.query(`
    -- Fee model reads that failed in a way that may not last (HTTP 4xx, a body
    -- that is not the JSON Sonata uploaded, no metadata account): the market
    -- is read again every pass, its funds owed, until the reads have failed
    -- for 24 hours since first_failed_at; then it is cached as holders
    -- (indexer/modules/fee-model.mjs).
    create table if not exists fee_model_failures (
      pool text primary key,
      first_failed_at timestamptz not null default now(),
      last_failed_at timestamptz not null default now(),
      failures integer not null default 1,
      last_error text
    );
    -- How far the search for a leftover withdrawal someone else sent has got
    -- (indexer/modules/airdrop.mjs findWithdrawal), one row per pool while it
    -- runs. The DBC pool's history is read newest first, a bounded number of
    -- transactions per pass; each pass carries on after before_signature (the
    -- oldest signature already checked), so transactions newer than the
    -- withdrawal delay it but never hide it. The row is deleted when the
    -- withdrawal is recorded, or when a walk ends without it (the next one
    -- starts at the newest). read and unreadable count this walk's
    -- transactions, for the log.
    create table if not exists airdrop_withdraw_search (
      pool text primary key,
      before_signature text,
      read integer not null default 0,
      unreadable integer not null default 0,
      started_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
}

/** `ledger` (a pgLedger on `db`) with the crank's extra methods. */
export function crankLedger(ledger, db) {
  return {
    ...ledger,
    // Records one failed read and returns when the first one was, and how long
    // ago by the database's clock (the one that wrote it).
    async feeModelFailure(pool, reason) {
      const { rows: [r] } = await db.query(
        `insert into fee_model_failures (pool, last_error) values ($1, $2)
         on conflict (pool) do update
           set last_failed_at = now(), failures = fee_model_failures.failures + 1, last_error = excluded.last_error
         returning first_failed_at, failures, floor(extract(epoch from (now() - first_failed_at)) * 1000)::bigint::text as elapsed_ms`,
        [pool, String(reason).slice(0, 300)],
      );
      return { firstFailedAt: new Date(r.first_failed_at), failures: Number(r.failures), elapsedMs: Number(r.elapsed_ms) };
    },
    // Where the pool's withdrawal search stopped last pass: { before, read, unreadable }, or null to start at the newest.
    async airdropSearch(pool) {
      const { rows: [r] } = await db.query("select before_signature, read, unreadable from airdrop_withdraw_search where pool = $1", [pool]);
      return r ? { before: r.before_signature ?? null, read: Number(r.read), unreadable: Number(r.unreadable) } : null;
    },
    // Saves where the search carries on next pass; null clears it (found, or a walk that ended).
    async airdropSaveSearch(pool, cursor) {
      if (!cursor) {
        await db.query("delete from airdrop_withdraw_search where pool = $1", [pool]);
        return;
      }
      await db.query(
        `insert into airdrop_withdraw_search (pool, before_signature, read, unreadable) values ($1, $2, $3, $4)
         on conflict (pool) do update
           set before_signature = excluded.before_signature, read = excluded.read, unreadable = excluded.unreadable, updated_at = now()`,
        [pool, cursor.before ?? null, cursor.read ?? 0, cursor.unreadable ?? 0],
      );
    },
  };
}
