// Tables for the payout ledger's allocation rounds, balance snapshots and the
// LP Farm's position-NFT holder caches (indexer/modules/payout.mjs,
// holders.mjs, diamond.mjs, lp-farm.mjs, top-buyers.mjs; read and written through
// indexer/rewards.mjs pgLedger). Called at the end of sonata-indexer's
// migrate(); every statement is idempotent.
export async function migrateLedgerTables(db) {
  await db.query(`
    -- One row per recipient per allocation round. A round is snapshotted once
    -- (recipients and amounts written before anything is sent) and its rows
    -- are paid over as many passes as it takes: a row stays the recipient's
    -- until it is paid, so a pass that stops early, or a recipient that
    -- cannot receive yet, never re-splits that amount to anyone else.
    -- status: unpaid -> pending (its transaction is in reward_pending, under
    -- signature) -> paid; a failed or expired transaction sets it back to
    -- unpaid. kind 'position' is an LP Farm position whose NFT holder was not
    -- found yet (recipient is the position address; paid_to is the wallet
    -- paid). creates_account marks a row whose transaction created the
    -- recipient's quote account, so the crank creates it at most once.
    create table if not exists reward_allocations (
      pool text not null,
      round int not null,
      recipient text not null,
      kind text not null default 'wallet' check (kind in ('wallet', 'position')),
      module text not null,
      amount numeric not null check (amount > 0),
      weight numeric,
      status text not null default 'unpaid' check (status in ('unpaid', 'pending', 'paid')),
      signature text,
      paid_to text,
      creates_account boolean not null default false,
      created_at timestamptz not null default now(),
      paid_at timestamptz,
      primary key (pool, round, recipient)
    );
    create index if not exists reward_allocations_open on reward_allocations (pool) where status <> 'paid';
    create index if not exists reward_allocations_signature on reward_allocations (signature);
    -- Balances seen by the crank each pass: kind 'holders' (Diamond Hands and
    -- Top Buyer Bounty: each holder wallet's base-token balance) or 'lp' (LP
    -- Farm: each DAMM v2 position's unlocked liquidity). A snapshot row with
    -- no balance rows means nobody held anything, so absence is known, not
    -- guessed.
    create table if not exists balance_snapshots (
      pool text not null,
      kind text not null check (kind in ('holders', 'lp')),
      taken_at timestamptz not null,
      primary key (pool, kind, taken_at)
    );
    create table if not exists balance_snapshot_rows (
      pool text not null,
      kind text not null,
      taken_at timestamptz not null,
      holder text not null,
      amount numeric not null,
      primary key (pool, kind, taken_at, holder),
      foreign key (pool, kind, taken_at) references balance_snapshots on delete cascade
    );
    create index if not exists balance_snapshot_rows_holder on balance_snapshot_rows (pool, kind, holder, taken_at);
    -- Where a moved LP position NFT was last found (owner null: looked up and
    -- not found), so every position is resolved over a few passes.
    create table if not exists lp_nft_holders (
      nft_mint text primary key,
      account text,
      owner text,
      checked_at timestamptz not null default now()
    );
    -- The last wallet seen holding the NFT of an LP Farm position that is owed
    -- a position row (reward_allocations kind 'position'): once the position
    -- is closed (its NFT burned), its rows are paid to that wallet.
    create table if not exists lp_position_holders (
      position text primary key,
      pool text not null,
      owner text not null,
      seen_at timestamptz not null default now()
    );
  `);
}
