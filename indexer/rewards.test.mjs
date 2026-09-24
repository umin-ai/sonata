import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  AccountType,
  ExtensionType,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccountLen,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  MAX_RECIPIENTS,
  MAX_TX_BYTES,
  batchTransfers,
  owedAtoms,
  pgLedger,
  receivable,
  resolvePending,
  rewardShares,
  selectHolders,
  settle,
  takeBatch,
  transferItems,
  txBytes,
} from "./rewards.mjs";

const key = () => Keypair.generate().publicKey;
// An off-curve address, as a program's PDA (pool authority, DAMM v2 pool, vault).
const pda = (seed = "vault") => PublicKey.findProgramAddressSync([Buffer.from(seed)], key())[0];

// A token account as the chain stores it. Token-2022 extensions are
// [type, data] pairs after the account-type byte.
function tokenAccount({ owner, mint, amount = 0n, state = AccountState.Initialized, program = TOKEN_PROGRAM_ID, extensions = [] }) {
  const size = extensions.length ? getAccountLen(extensions.map(([t]) => t)) : ACCOUNT_SIZE;
  const data = Buffer.alloc(size);
  AccountLayout.encode(
    {
      mint, owner, amount, state,
      delegateOption: 0, delegate: PublicKey.default, isNativeOption: 0, isNative: 0n,
      delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
    },
    data,
  );
  if (extensions.length) {
    data[ACCOUNT_SIZE] = AccountType.Account;
    let at = ACCOUNT_SIZE + 1;
    for (const [type, body = Buffer.alloc(0)] of extensions) {
      data.writeUInt16LE(type, at);
      data.writeUInt16LE(body.length, at + 2);
      body.copy(data, at + 4);
      at += 4 + body.length;
    }
  }
  return { data, owner: program, lamports: 2_039_280, executable: false };
}
const held = (mint, owner, amount, over = {}) => ({ pubkey: over.pubkey ?? key(), account: tokenAccount({ owner, mint, amount, ...over }) });
const owners = (holders) => holders.map((h) => h.owner.toBase58());

test("owed is the onchain lifetime payout minus what the ledger has paid", () => {
  assert.equal(owedAtoms(1_000_000n, 0n), 1_000_000n);
  assert.equal(owedAtoms("1000000", "777777"), 222_223n);
  assert.equal(owedAtoms(5n, 5n), 0n);
  // A ledger that paid more than the treasury ever distributed is never trusted.
  assert.throws(() => owedAtoms(10n, 11n), /more than the 10 distributed onchain/);
});

test("holders exclude the pool vault, the treasury, the crank key, PDAs and dust, summed per wallet", () => {
  const mint = key(), crank = key(), supply = 1_000_000_000n;
  const [a, b, c, tiny, edge] = [key(), key(), key(), key(), key()];
  const baseVault = key(), treasuryBase = key();
  const accounts = [
    held(mint, a, 300_000_000n),
    held(mint, b, 200_000_000n),
    // A second account of the same wallet counts toward one balance.
    held(mint, a, 50_000_000n),
    held(mint, c, 100_000_000n),
    // Explicit exclusions, owned by signing wallets so only the address rules them out.
    held(mint, key(), 150_000_000n, { pubkey: baseVault }),
    held(mint, key(), 40_000_000n, { pubkey: treasuryBase }),
    held(mint, crank, 90_000_000n),
    // Owners off the ed25519 curve.
    held(mint, pda("pool-authority"), 60_000_000n),
    held(mint, pda("damm"), 60_000_000n),
    // 0.01% of supply is 100000 atoms: exactly that is in, one less is out.
    held(mint, edge, 100_000n),
    held(mint, tiny, 99_999n),
    // Other mints, empty accounts, and accounts of another token program.
    held(key(), key(), 500_000_000n),
    held(mint, key(), 0n),
    held(mint, key(), 70_000_000n, { program: TOKEN_2022_PROGRAM_ID }),
  ];
  const holders = selectHolders(accounts, { mint, supply, excludedAccounts: [baseVault, treasuryBase], excludedOwners: [crank] });
  assert.deepEqual(owners(holders), [a, b, c, edge].map(String));
  assert.deepEqual(holders.map((h) => h.balance), [350_000_000n, 200_000_000n, 100_000_000n, 100_000n]);
  assert.deepEqual(selectHolders(accounts, { mint, supply: 0n }), []);
});

test("at most the top 200 holders by balance, ties by address", () => {
  const mint = key();
  // Balances 1000000..1000259: 199 are above 1000060, and three wallets hold
  // exactly 1000060 (i = 60 and two more), so one seat is left for three.
  const accounts = Array.from({ length: 260 }, (_, i) => held(mint, key(), 1_000_000n + BigInt(i)));
  accounts.push(held(mint, key(), 1_000_060n), held(mint, key(), 1_000_060n));
  const holders = selectHolders(accounts, { mint, supply: 1_000_000_000n });
  assert.equal(holders.length, MAX_RECIPIENTS);
  assert.equal(holders[0].balance, 1_000_259n);
  assert.ok(holders.every((h, i) => !i || holders[i - 1].balance >= h.balance));
  const tied = accounts
    .map(({ account }) => AccountLayout.decode(account.data))
    .filter((a) => a.amount === 1_000_060n)
    .map((a) => a.owner.toBase58())
    .sort();
  assert.equal(tied.length, 3);
  assert.deepEqual(holders.filter((h) => h.balance === 1_000_060n).map((h) => h.owner.toBase58()), [tied[0]]);
  // The smallest balance kept is at least every balance left out.
  const kept = new Set(owners(holders));
  const smallest = holders.at(-1).balance;
  for (const { account } of accounts) {
    const a = AccountLayout.decode(account.data);
    if (!kept.has(a.owner.toBase58())) assert.ok(a.amount <= smallest);
  }
});

test("shares are pro rata, rounded down, zero shares dropped, never more than owed", () => {
  const h = (balance) => ({ owner: key(), balance });
  const three = rewardShares([h(1n), h(1n), h(1n)], 100n);
  assert.deepEqual(three.map((s) => s.amount), [33n, 33n, 33n]);
  // 1000000 over 4:3:2 of 9: the remainder stays owed.
  assert.deepEqual(rewardShares([h(400n), h(300n), h(200n)], 1_000_000n).map((s) => s.amount), [444_444n, 333_333n, 222_222n]);
  const dust = rewardShares([h(1_000_000n), h(1n)], 5n);
  assert.equal(dust.length, 1);
  assert.equal(dust[0].amount, 4n);
  assert.deepEqual(rewardShares([h(10n)], 0n), []);
  assert.deepEqual(rewardShares([], 10n), []);
  // Random holder sets: the total never exceeds owed, and rounding loses less
  // than one atom per holder.
  let seed = 7n;
  const rand = (max) => ((seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n) % max) + 1n;
  for (let round = 0; round < 500; round++) {
    const holders = Array.from({ length: Number(rand(200n)) }, (_, i) => ({ owner: i, balance: rand(10n ** 15n) }));
    const owed = rand(10n ** 12n);
    const shares = rewardShares(holders, owed);
    const paid = shares.reduce((s, x) => s + x.amount, 0n);
    const total = holders.reduce((s, x) => s + x.balance, 0n);
    assert.ok(paid <= owed);
    assert.ok(owed - paid < BigInt(holders.length));
    for (const s of shares) {
      assert.ok(s.amount > 0n);
      assert.equal(s.amount, (owed * s.balance) / total);
    }
  }
});

test("only an existing, usable quote account of the holder receives a transfer", () => {
  const owner = key(), mint = key(), address = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  const t22 = (over = {}) => tokenAccount({ owner, mint, program: TOKEN_2022_PROGRAM_ID, extensions: [[ExtensionType.ImmutableOwner]], ...over });
  assert.equal(receivable(address, null, owner, mint), "missing");
  assert.equal(receivable(address, t22(), owner, mint), null);
  assert.equal(receivable(address, t22({ extensions: [] }), owner, mint), null);
  assert.equal(receivable(address, t22({ owner: key() }), owner, mint), "invalid");
  assert.equal(receivable(address, t22({ mint: key() }), owner, mint), "invalid");
  assert.equal(receivable(address, t22({ program: TOKEN_PROGRAM_ID, extensions: [] }), owner, mint), "invalid");
  assert.equal(receivable(address, t22({ state: AccountState.Frozen }), owner, mint), "frozen");
  const memo = (on) => t22({ extensions: [[ExtensionType.ImmutableOwner], [ExtensionType.MemoTransfer, Buffer.from([on])]] });
  assert.equal(receivable(address, memo(1), owner, mint), "memo");
  assert.equal(receivable(address, memo(0), owner, mint), null);
  assert.equal(receivable(address, t22({ extensions: [[ExtensionType.TransferHookAccount, Buffer.from([0])]] }), owner, mint), "extension");
});

// 200 payouts from one quote account, as the crank builds them.
function payouts(n = 200) {
  const authority = key(), mint = key();
  const source = getAssociatedTokenAddressSync(mint, authority, false, TOKEN_2022_PROGRAM_ID);
  const list = Array.from({ length: n }, (_, i) => {
    const owner = key();
    return { owner, balance: 1n, amount: 10n ** 12n + BigInt(i), destination: getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID) };
  });
  return { authority, mint, source, items: transferItems(list, { source, mint, authority, decimals: 8 }) };
}

test("transfers are Token-2022 transfer_checked from the crank's quote account", () => {
  const { authority, mint, source, items } = payouts(1);
  const [{ ix, payout }] = items;
  assert.ok(ix.programId.equals(TOKEN_2022_PROGRAM_ID));
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), [source, mint, payout.destination, authority].map(String));
  assert.deepEqual(ix.keys.map((k) => [k.isSigner, k.isWritable]), [[false, true], [false, false], [false, true], [true, false]]);
  // transfer_checked: discriminator 12, u64 amount, u8 decimals.
  assert.equal(ix.data[0], 12);
  assert.equal(ix.data.readBigUInt64LE(1), payout.amount);
  assert.equal(ix.data[9], 8);
});

test("batches hold as many transfers as fit in 1,232 bytes, measured", () => {
  const { authority, items } = payouts(200);
  const batches = batchTransfers(items, authority);
  assert.deepEqual(batches.flat(), items);
  for (const [i, batch] of batches.entries()) {
    assert.ok(txBytes(batch.map((b) => b.ix), authority) <= MAX_TX_BYTES);
    // Maximal: the next transfer would not have fit.
    if (i < batches.length - 1)
      assert.ok(txBytes([...batch, batches[i + 1][0]].map((b) => b.ix), authority) > MAX_TX_BYTES);
  }
  // The crank key signs alone: 230 bytes of signature, header, shared keys and
  // blockhash, plus 49 per transfer (a 32-byte destination and a 17-byte
  // instruction), so 20 transfers per transaction (1,210 bytes); 200 holders
  // take 10 transactions. No compute budget instruction is needed (20
  // transfer_checked stay far below the default limit), and one would cost a transfer.
  assert.equal(batches[0].length, 20);
  assert.equal(txBytes(batches[0].map((b) => b.ix), authority), 1210);
  assert.equal(batches.length, 10);
  // With a separate fee payer (a dry run simulated as the creator) one more
  // signature and key fit 18.
  const payer = key();
  const twoSigners = takeBatch(items, payer);
  assert.equal(twoSigners.length, 18);
  assert.ok(txBytes(twoSigners.map((b) => b.ix), payer) <= MAX_TX_BYTES);
  assert.throws(() => takeBatch(items, authority, 200), /does not fit/);
  assert.deepEqual(takeBatch([], authority), []);
});

// A fake RPC for signature statuses and block height.
const statusRpc = ({ statuses = {}, history = statuses, height = 0 }) => {
  const calls = [];
  return {
    calls,
    rpc: (fn) => fn(),
    connection: {
      getSignatureStatuses: async (sigs, opts) => {
        calls.push(opts?.searchTransactionHistory ? "history" : "status");
        const from = opts?.searchTransactionHistory ? history : statuses;
        return { value: sigs.map((s) => from[s] ?? null) };
      },
      getBlockHeight: async () => (calls.push("height"), typeof height === "function" ? height() : height),
    },
  };
};

test("a sent payout settles as confirmed, failed, expired or still unknown", async () => {
  const ok = statusRpc({ statuses: { s: { err: null, confirmationStatus: "confirmed" } } });
  assert.deepEqual(await settle({ ...ok, signature: "s", lastValidBlockHeight: 100, pollMs: 0 }), { state: "confirmed" });
  const bad = statusRpc({ statuses: { s: { err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: "confirmed" } } });
  assert.equal((await settle({ ...bad, signature: "s", lastValidBlockHeight: 100, pollMs: 0 })).state, "failed");
  // Not seen and its blockhash has expired: checked once more in full history.
  const gone = statusRpc({ height: 101 });
  assert.deepEqual(await settle({ ...gone, signature: "s", lastValidBlockHeight: 100, pollMs: 0 }), { state: "expired" });
  assert.deepEqual(gone.calls, ["status", "status", "status", "status", "status", "height", "history"]);
  const late = statusRpc({ history: { s: { err: null, confirmationStatus: "finalized" } }, height: 101 });
  assert.equal((await settle({ ...late, signature: "s", lastValidBlockHeight: 100, pollMs: 0 })).state, "confirmed");
  // Blockhash still valid when polling ends: left pending for the next pass.
  const waiting = statusRpc({ height: 50 });
  assert.equal((await settle({ ...waiting, signature: "s", lastValidBlockHeight: 100, pollMs: 0, polls: 10 })).state, "unknown");
});

test("payouts left pending by an earlier pass are settled from the chain", async () => {
  const rows = ["landed", "failed", "gone", "young", "processed"].map((signature, i) => ({
    signature, pool: `pool${i}`, amount: 10n, recipients: 2, lastValidBlockHeight: signature === "young" ? 500 : 100,
  }));
  const done = { confirmed: [], dropped: [] };
  const ledger = {
    pending: async () => rows,
    confirm: async (s) => done.confirmed.push(s),
    drop: async (s) => done.dropped.push(s),
  };
  const chain = statusRpc({
    statuses: {
      landed: { err: null, confirmationStatus: "finalized" },
      failed: { err: { InstructionError: [1, "InvalidAccountData"] }, confirmationStatus: "confirmed" },
      processed: { err: null, confirmationStatus: "processed" },
    },
    height: 200,
  });
  const lines = [];
  await resolvePending({ ledger, ...chain, log: (tag, f) => lines.push({ tag, ...f }) });
  assert.deepEqual(done, { confirmed: ["landed"], dropped: ["failed", "gone"] });
  // One status call for all of them, one block height for the unseen ones.
  assert.deepEqual(chain.calls, ["history", "height"]);
  assert.deepEqual(lines.map((l) => l.result), ["paid", "failed", "expired", "pending", "pending"]);
});

test("the ledger counts pending payouts as paid and moves them on confirmation", async () => {
  const queries = [];
  const db = {
    query: async (sql, args) => {
      queries.push({ sql: sql.replace(/\s+/g, " ").trim(), args });
      if (/to_regclass/.test(sql)) return { rows: [{ ok: true }] };
      if (/as paid/.test(sql)) return { rows: [{ paid: "123456789012345678901" }] };
      if (/from reward_pending order by/.test(sql))
        return { rows: [{ signature: "sig", pool: "p", amount: "42", recipients: 3, lvbh: "987" }] };
      return { rows: [] };
    },
  };
  const ledger = pgLedger(db);
  assert.equal(await ledger.ready(), true);
  assert.equal(await ledger.paid("p"), 123456789012345678901n);
  assert.match(queries[1].sql, /reward_payouts where pool = \$1.*\+.*reward_pending where pool = \$1/);
  assert.deepEqual(queries[1].args, ["p"]);
  // Rows written before fee modules existed are holders payouts.
  assert.deepEqual(await ledger.pending(), [{ signature: "sig", pool: "p", amount: 42n, recipients: 3, lastValidBlockHeight: 987, module: "holders" }]);
  await ledger.begin({ signature: "s2", pool: "p", amount: 5n, recipients: 1, lastValidBlockHeight: 9 });
  assert.deepEqual(queries.at(-1).args, ["s2", "p", "5", 1, 9, "holders", null]);
  // A module's detail is stored as JSON, bigints and keys as strings.
  const winner = key();
  await ledger.begin({ signature: "s3", pool: "p", amount: 7n, recipients: 1, lastValidBlockHeight: 9, module: "topBuyers", detail: { roundEnd: 60, winners: [{ trader: winner, amount: 7n }] } });
  assert.match(queries.at(-1).sql, /\$7::jsonb/);
  assert.deepEqual(JSON.parse(queries.at(-1).args[6]), { roundEnd: 60, winners: [{ trader: winner.toBase58(), amount: "7" }] });
  await ledger.confirm("s2");
  assert.match(queries.at(-1).sql, /delete from reward_pending where signature = \$1 returning \*.*insert into reward_payouts .*module, detail\) select .*module, detail from moved on conflict \(signature\) do nothing/);
  await ledger.drop("s2");
  assert.equal(queries.at(-1).sql, "delete from reward_pending where signature = $1");
});
