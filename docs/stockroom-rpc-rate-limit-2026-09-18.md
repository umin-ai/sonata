

## RPC rate-limit handling — 18 September 2026

The shared public Solana Devnet RPC returned HTTP/JSON-RPC 429 across live sections. Added a paced request queue (350ms minimum start spacing), in-flight read deduplication with caller-specific JSON-RPC IDs, one bounded retry for rate-limited reads, and readable busy errors. Concurrent genesis checks share one promise. No completed account caching; writes are neither retried nor deduplicated. Failed reward/reserve reads no longer imply empty allocations or zero balances.

Validation: TypeScript passed; five transport regression tests passed; production build and git diff check passed. Local browser refreshed successfully and displayed both ROOM/mSPY and CREW/mSPY markets with fetched reserve amounts. Public RPC capacity remains an external limitation; this is mitigation, not a dedicated provider deployment. No funds moved.
