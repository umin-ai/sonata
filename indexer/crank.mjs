// Sonata creator payout crank. One pass over every Sonata market, then exit
// (deploy/lightsail/sonata-crank.timer runs it every 15 minutes).
//
// For each treasury of the Sonata treasury program:
//   1. `claim` pulls the pool's partner fees from Meteora DBC into the treasury,
//      when the pool's partnerQuoteFee is at least CRANK_MIN_ATOMS; after
//      graduation `claim_graduated` pulls the fees the Vault's locked DAMM v2
//      position has earned (indexer/modules/graduated.mjs), when a simulation
//      shows at least CRANK_MIN_ATOMS arriving;
//   2. `distribute` splits what is claimed but unallocated by the treasury's
//      mode (refrain 100% payout; duet 50/50; floor 50% payout, 50% Stock Floor),
//      or, for the modes with a Sonata platform share, `distribute_split` does
//      (standard 50% creator, 50% Sonata; standardFloor 25% creator, 25% Stock
//      Floor, 50% Sonata). Sonata's share goes to the Token-2022 quote account of
//      the Vault admin, read from the Vault account each pass.
// These instructions are permissionless and every destination is pinned
// onchain, so for these the key only pays network fees (and rent for a missing
// payout or platform token account), never redirects funds. Claim and distribute
// are built as lib/treasury/runtime.ts prepareTreasury builds them for "collect",
// "allocate" and "sync", and markets are verified as readTreasury verifies them.
//
// Reward tokens (indexer/rewards.mjs) are the exception: markets whose
// payout_owner is this key. Their creator share lands in this key's quote
// account, and after the step above the crank passes it on by the market's fee
// module (named in the token's metadata JSON: holders, buyback, topBuyers,
// lpFarm, split or diamond; indexer/modules/), recorded in the indexer's
// PostgreSQL ledger.
//
// Graduation airdrops (indexer/modules/airdrop.mjs) run last, for any market
// whose DBC config names this key as leftover receiver.
//
// Env: CRANK_KEYPAIR (default /opt/sonata/crank-keypair.json),
//      SOLANA_RPC_URL (default: public Devnet), CRANK_MIN_ATOMS (default 10000),
//      CRANK_DRY_RUN=1 (build and simulate only; nothing is sent),
//      CRANK_SPACING_MS (pause between RPC calls, default 500),
//      DATABASE_URL (the reward ledger; without it reward payouts and airdrops
//      are skipped, and graduated positions are looked up every pass),
//      REWARD_MIN_ATOMS (smallest owed amount paid out, default 100000).
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import anchor from "@coral-xyz/anchor";
import bs58 from "bs58";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { DEFAULT_REWARD_MIN_ATOMS, MAX_TX_BYTES, payRewards, pgLedger, txBytes } from "./rewards.mjs";
import { runAirdrops } from "./modules/airdrop.mjs";
import { simulatedAmount } from "./modules/common.mjs";
import { DAMM_EVENT_AUTHORITY, DAMM_POOL_AUTHORITY, graduatedAccounts } from "./modules/graduated.mjs";

export { MAX_TX_BYTES, txBytes };

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const treasuryIdl = json("../lib/treasury/stockroom_treasury.json");
const dbcIdl = json("../lib/treasury/dbc.json");
const dbc = json("../lib/treasury/dbc-addresses.json");
const QUOTE_MINTS = new Set(json("../lib/treasury/quote-assets.json").assets.map((a) => a.mint));

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const DEFAULT_MIN_ATOMS = 10_000n;
// Reward payouts start no new transaction after this much of a pass, well inside
// the service's TimeoutStartSec; what is left stays owed for the next pass.
const REWARD_BUDGET_MS = 8 * 60_000;
const pk = (s) => new PublicKey(s);
// Only builds instructions and decodes accounts; it never sends through this connection.
const program = new anchor.Program(treasuryIdl, { connection: new Connection("http://127.0.0.1:1") });
const dbcCoder = new anchor.BorshAccountsCoder(dbcIdl);
const TREASURY_DISCRIMINATOR = Buffer.from(
  treasuryIdl.accounts.find((a) => a.name === "Treasury").discriminator,
);
const [VAULT] = PublicKey.findProgramAddressSync([Buffer.from("stockroom")], program.programId);
const DAMM_PROGRAM = pk("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
if (VAULT.toBase58() !== json("../lib/treasury/market.json").vault)
  throw Error("Sonata fee vault does not match lib/treasury/market.json.");
// Onchain Mode variants the crank handles, by the anchor coder's key. Sustain is
// never launched by the app and is skipped.
const MODES = ["refrain", "duet", "floor", "standard", "standardFloor"];
// Modes with a Sonata platform share, split by `distribute_split`.
export const SPLIT_MODES = new Set(["standard", "standardFloor"]);
export const modeOf = (m) => MODES.find((k) => m && k in m) ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// spl-token errors carry only a name, so fall back to it.
const errText = (e) => String(e?.message || e?.name || e).slice(0, 200);
const check = (label, fn) => {
  try {
    return fn();
  } catch (e) {
    throw Error(`${label}: ${errText(e)}`);
  }
};

/**
 * What one market needs this pass. Amounts are raw quote atoms (bigint).
 *   partnerQuoteFee    the DBC pool's unclaimed partner fee (what `claim` pulls)
 *   graduatedFee       after graduation, what `claim_graduated` would move into
 *                      the treasury, from a simulation (undefined before)
 *   unallocated        treasury totalClaimed - totalDistributed - totalRetained
 *   treasuryBaseReady  the treasury's base token account exists, unfrozen (`claim` needs it)
 *   payoutAccount      "ok" | "missing" (created in the same transaction) | "frozen"
 *   platformAccount    as payoutAccount, for the Vault admin's quote account; only
 *                      in the modes with a platform share (undefined otherwise)
 *   migrated           the pool graduated; claim is still attempted and logged
 */
export function planMarket(s, minAtoms = DEFAULT_MIN_ATOMS) {
  const feeReady = s.partnerQuoteFee > 0n && s.partnerQuoteFee >= minAtoms;
  const claim = feeReady && s.treasuryBaseReady;
  const graduatedFee = s.graduatedFee ?? 0n;
  const graduatedReady = graduatedFee > 0n && graduatedFee >= minAtoms;
  const claimGraduated = graduatedReady && s.treasuryBaseReady;
  const frozen = s.payoutAccount === "frozen" ? "payout" : s.platformAccount === "frozen" ? "platform" : null;
  // A claim leaves something unallocated, so it is always followed by a split.
  const distribute = !frozen && (claim || claimGraduated || s.unallocated > 0n);
  const createPayout = distribute && s.payoutAccount === "missing";
  const createPlatform = distribute && s.platformAccount === "missing";
  let reason = null;
  if ((feeReady || graduatedReady) && !s.treasuryBaseReady) reason = "treasury base token account missing or frozen; cannot claim";
  else if (frozen && (claim || claimGraduated || s.unallocated > 0n))
    reason = `${frozen} token account frozen; cannot distribute`;
  else if (!claim && !claimGraduated && !distribute)
    reason = s.partnerQuoteFee > 0n
      ? `partner fee ${s.partnerQuoteFee} below ${minAtoms}; nothing unallocated`
      : graduatedFee > 0n
        ? `graduated fee ${graduatedFee} below ${minAtoms}; nothing unallocated`
        : "nothing to claim or distribute";
  return { claim, claimGraduated, distribute, createPayout, createPlatform, reason };
}

// Account lists as in lib/treasury/runtime.ts prepareTreasury.
const claimIx = (m) =>
  program.methods
    .claim()
    .accounts({
      vault: VAULT,
      treasury: m.treasury,
      poolAuthority: pk(dbc.poolAuthority),
      config: m.config,
      pool: m.pool,
      treasuryBase: m.treasuryBase,
      treasuryQuote: m.treasuryQuote,
      baseVault: m.baseVault,
      quoteVault: m.quoteVault,
      baseMint: m.baseMint,
      quoteMint: m.quoteMint,
      tokenBaseProgram: TOKEN_PROGRAM_ID,
      tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
      dbcEventAuthority: pk(dbc.eventAuthority),
      dbcProgram: pk(dbc.program),
    })
    .instruction();
const distributeIx = (m) =>
  program.methods
    .distribute()
    .accounts({
      treasury: m.treasury,
      treasuryQuote: m.treasuryQuote,
      payoutQuote: m.payoutQuote,
      quoteMint: m.quoteMint,
      tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction();
// The program checks the Vault's seeds and that platformQuote belongs to its admin.
const distributeSplitIx = (m) =>
  program.methods
    .distributeSplit()
    .accountsStrict({
      vault: VAULT,
      treasury: m.treasury,
      treasuryQuote: m.treasuryQuote,
      payoutQuote: m.payoutQuote,
      platformQuote: m.platformQuote,
      quoteMint: m.quoteMint,
      tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction();

// After graduation: the Vault's locked DAMM v2 position fees into the treasury
// (accounts as stockroom-protocol/scripts/verify-graduated-claim.mjs). `g` is
// the market's graduated pool and position (modules/graduated.mjs).
export const claimGraduatedIx = (m, g) =>
  program.methods
    .claimGraduated()
    .accountsStrict({
      vault: VAULT,
      treasury: m.treasury,
      dammPoolAuthority: DAMM_POOL_AUTHORITY,
      dammPool: g.dammPool,
      position: g.position,
      treasuryBase: m.treasuryBase,
      treasuryQuote: m.treasuryQuote,
      tokenAVault: g.tokenAVault,
      tokenBVault: g.tokenBVault,
      baseMint: m.baseMint,
      quoteMint: m.quoteMint,
      positionNftAccount: g.positionNftAccount,
      tokenBaseProgram: TOKEN_PROGRAM_ID,
      tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
      dammEventAuthority: DAMM_EVENT_AUTHORITY,
      dammProgram: DAMM_PROGRAM,
    })
    .instruction();

/**
 * The transactions for a plan: one when claim and distribute fit together,
 * otherwise claim first and distribute after it confirms. Each step is a list
 * of { label, ix } so a failing instruction index can be named.
 */
export async function buildSteps(m, plan, feePayer) {
  const budget = () => ({ label: "compute budget", ix: ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }) });
  if (plan.claimGraduated && !m.graduated?.position) throw Error("graduated position unknown; cannot claim_graduated");
  const claim = [
    ...(plan.claim ? [{ label: "claim", ix: await claimIx(m) }] : []),
    ...(plan.claimGraduated ? [{ label: "claim_graduated", ix: await claimGraduatedIx(m, m.graduated) }] : []),
  ];
  const split = SPLIT_MODES.has(m.mode);
  if (split && plan.distribute && !m.platformQuote) throw Error("platform account unknown; cannot distribute_split");
  const create = (label, account, owner) => ({
    label,
    ix: createAssociatedTokenAccountIdempotentInstruction(feePayer, account, owner, m.quoteMint, TOKEN_2022_PROGRAM_ID),
  });
  const pay = [];
  if (plan.createPayout) pay.push(create("create payout account", m.payoutQuote, m.payoutOwner));
  // When the payout owner is the Vault admin both are one account, created once.
  if (split && plan.createPlatform && !(plan.createPayout && m.platformQuote.equals(m.payoutQuote)))
    pay.push(create("create platform account", m.platformQuote, m.platformOwner));
  if (plan.distribute)
    pay.push(split
      ? { label: "distribute_split", ix: await distributeSplitIx(m) }
      : { label: "distribute", ix: await distributeIx(m) });
  const single = [budget(), ...claim, ...pay];
  if (!claim.length || !pay.length || txBytes(single.map((s) => s.ix), feePayer) <= MAX_TX_BYTES)
    return [single];
  return [[budget(), ...claim], [budget(), ...pay]];
}

// Addresses of one market, derived from its treasury account alone.
function marketOf(address, t) {
  const treasury = address;
  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), t.pool.toBuffer()],
    program.programId,
  );
  if (!expected.equals(treasury)) throw Error("treasury address does not match its pool");
  return {
    treasury,
    pool: t.pool,
    config: t.config,
    quoteMint: t.quoteMint,
    baseMint: t.baseMint,
    creator: t.creator,
    payoutOwner: t.payoutOwner,
    mode: modeOf(t.mode),
    totals: [t.totalClaimed, t.totalDistributed, t.totalRetained, t.totalWithdrawn].map((v) =>
      BigInt(v.toString()),
    ),
    treasuryBase: getAssociatedTokenAddressSync(t.baseMint, treasury, true, TOKEN_PROGRAM_ID),
    treasuryQuote: getAssociatedTokenAddressSync(t.quoteMint, treasury, true, TOKEN_2022_PROGRAM_ID),
    payoutQuote: getAssociatedTokenAddressSync(t.quoteMint, t.payoutOwner, true, TOKEN_2022_PROGRAM_ID),
  };
}

/**
 * A reward market's lifetime payout-owner total from a fresh read of its
 * treasury account, after this pass's distribute. Throws unless it is still
 * the same market's treasury.
 */
export function rewardTotals(info, m) {
  if (!info?.owner.equals(program.programId)) throw Error("treasury account missing or not owned by the treasury program");
  const t = check("treasury", () => program.coder.accounts.decode("treasury", Buffer.from(info.data)));
  if (!t.pool.equals(m.pool) || !t.payoutOwner.equals(m.payoutOwner) || !t.quoteMint.equals(m.quoteMint) || !t.baseMint.equals(m.baseMint))
    throw Error("treasury does not match this market");
  return { totalDistributed: BigInt(t.totalDistributed.toString()) };
}

// The DBC pool's base vault, checked as inspect() checks the pool.
function poolBaseVault(m, info) {
  if (!info?.owner.equals(pk(dbc.program))) throw Error("pool is not owned by Meteora DBC");
  const decoded = dbcCoder.decode("virtualPool", info.data);
  const p = decoded.poolState ?? decoded;
  if (!p.config.equals(m.config) || !p.baseMint.equals(m.baseMint)) throw Error("pool does not match this treasury");
  return p.baseVault;
}

/**
 * The Vault admin, who receives the platform share. Throws unless the account
 * is the treasury program's Vault.
 */
export function vaultAdmin(info) {
  if (!info?.owner.equals(program.programId)) throw Error("Sonata Vault account missing or not owned by the treasury program");
  const { admin } = check("vault", () => program.coder.accounts.decode("vault", Buffer.from(info.data)));
  if (admin.equals(PublicKey.default)) throw Error("Sonata Vault has no admin");
  return admin;
}

/**
 * State of a destination quote token account: "missing", "ok" or "frozen".
 * Throws if it exists but is not the owner's account for this mint.
 */
export function destinationState(label, address, info, owner, mint) {
  if (!info) return "missing";
  const a = check(label, () => unpackAccount(address, info, TOKEN_2022_PROGRAM_ID));
  if (!a.owner.equals(owner) || !a.mint.equals(mint)) throw Error(`${label} verification failed`);
  return a.isFrozen ? "frozen" : "ok";
}

// The same ownership, configuration, custody and accounting checks as readTreasury.
function inspect(m, info) {
  const [pool, config, treasuryBase, treasuryQuote, payoutQuote, quoteMint, platformQuote] = info;
  if (!pool?.owner.equals(pk(dbc.program)) || !config?.owner.equals(pk(dbc.program)))
    throw Error("pool or config is not owned by Meteora DBC");
  const decoded = dbcCoder.decode("virtualPool", pool.data);
  const p = decoded.poolState ?? decoded;
  const c = dbcCoder.decode("poolConfig", config.data);
  if (
    !c.feeClaimer.equals(VAULT) ||
    !c.quoteMint.equals(m.quoteMint) ||
    !p.config.equals(m.config) ||
    !p.baseMint.equals(m.baseMint)
  )
    throw Error("pool configuration does not match this treasury");
  m.baseVault = p.baseVault;
  m.quoteVault = p.quoteVault;
  const mint = check("quote mint", () => unpackMint(m.quoteMint, quoteMint, TOKEN_2022_PROGRAM_ID));
  if (mint.decimals !== 8 || mint.freezeAuthority) throw Error("unexpected quote mint");
  if (!treasuryQuote) throw Error("treasury quote token account missing");
  const custody = check("treasury quote account", () => unpackAccount(m.treasuryQuote, treasuryQuote, TOKEN_2022_PROGRAM_ID));
  if (!custody.owner.equals(m.treasury) || !custody.mint.equals(m.quoteMint) || custody.isFrozen)
    throw Error("treasury quote custody verification failed");
  let treasuryBaseReady = false;
  if (treasuryBase) {
    const base = check("treasury base account", () => unpackAccount(m.treasuryBase, treasuryBase, TOKEN_PROGRAM_ID));
    if (!base.owner.equals(m.treasury) || !base.mint.equals(m.baseMint))
      throw Error("treasury base custody verification failed");
    treasuryBaseReady = !base.isFrozen;
  }
  const payoutAccount = destinationState("payout token account", m.payoutQuote, payoutQuote, m.payoutOwner, m.quoteMint);
  const platformAccount = SPLIT_MODES.has(m.mode)
    ? destinationState("platform token account", m.platformQuote, platformQuote, m.platformOwner, m.quoteMint)
    : undefined;
  // In the platform modes the platform share is booked as retained and withdrawn
  // together, so retained - withdrawn is still the floor held in custody.
  const [claimed, paid, retained, withdrawn] = m.totals;
  const unallocated = claimed - paid - retained;
  const available = retained - withdrawn;
  if (unallocated < 0n || available < 0n || custody.amount < unallocated + available)
    throw Error("treasury accounting does not reconcile");
  return {
    partnerQuoteFee: BigInt(p.partnerQuoteFee.toString()),
    unallocated,
    treasuryBaseReady,
    payoutAccount,
    platformAccount,
    migrated: p.isMigrated !== 0,
    custody: custody.amount,
  };
}

// One short line from a failed simulation or transaction; program logs are public.
function describe(err, logs, step) {
  const index = err?.InstructionError?.[0];
  const where = index === undefined ? "transaction" : (step[index]?.label ?? `instruction ${index}`);
  const hint = [...(logs ?? [])].reverse().find((l) => /Error Message:|insufficient|failed:/i.test(l));
  const text = `${where}: ${JSON.stringify(err)}${hint ? ` ${hint.replace(/^Program log: /, "")}` : ""}`;
  return { where, text: text.slice(0, 300) };
}

const field = (v) => (/[\s"=]/.test(String(v)) ? JSON.stringify(String(v)) : String(v));
const format = (tag, fields) =>
  [tag, ...Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${field(v)}`)].join(" ");

/**
 * One pass over every market, then reward payouts for the markets whose payout
 * owner is `payer` (with `ledger`, see indexer/rewards.mjs pgLedger; null skips
 * them). Returns the counts, with `rewards` when there are reward markets;
 * per-market failures are logged and counted, never thrown. Throws only if the
 * pass cannot start (wrong network, or markets cannot be listed).
 */
export async function runPass({
  connection,
  payer,
  minAtoms = DEFAULT_MIN_ATOMS,
  dryRun = false,
  spacingMs = 500,
  log = console.log,
  ledger = null,
  rewardMinAtoms = DEFAULT_REWARD_MIN_ATOMS,
  confirmPollMs = 2000,
  fetchImpl = globalThis.fetch,
}) {
  const started = Date.now();
  let calls = 0;
  // Spaced, with backoff on the public RPC's rate limits (as indexer/index.mjs).
  // A signed transaction resent after a network error keeps its signature, so
  // a retry cannot pay twice.
  const rpc = async (fn) => {
    for (let attempt = 0; ; attempt++) {
      if (calls++) await sleep(spacingMs);
      try {
        return await fn();
      } catch (e) {
        const transient = !e?.transactionMessage && /\b429\b|Too Many Requests|fetch failed|timed? ?out|ECONNRESET/i.test(String(e?.message ?? e));
        if (attempt >= 6 || !transient) throw e;
        await sleep(Math.min(30_000, 1500 * 2 ** attempt));
      }
    }
  };

  if ((await rpc(() => connection.getGenesisHash())) !== DEVNET_GENESIS)
    throw Error("RPC is not Solana Devnet (genesis hash mismatch); nothing sent.");
  const listed = await rpc(() =>
    connection.getProgramAccounts(program.programId, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(TREASURY_DISCRIMINATOR) } }],
    }),
  );
  const counts = { markets: listed.length, sent: 0, simulated: 0, skipped: 0, failed: 0 };
  const markets = [];
  for (const { pubkey, account } of listed) {
    try {
      const m = marketOf(pubkey, program.coder.accounts.decode("treasury", account.data));
      if (!m.mode || !QUOTE_MINTS.has(m.quoteMint.toBase58())) {
        counts.skipped++;
        log(format("market", { pool: m.pool.toBase58(), action: "skip", reason: "unsupported mode or quote mint" }));
      } else markets.push(m);
    } catch (e) {
      counts.failed++;
      log(format("market", { treasury: pubkey.toBase58(), action: "fail", reason: errText(e) }));
    }
  }

  // The platform share goes to the Vault admin's quote account; the admin is read
  // from the Vault, one extra call, only when some market has a platform share.
  let vaultError = null;
  if (markets.some((m) => SPLIT_MODES.has(m.mode))) {
    try {
      const admin = vaultAdmin(await rpc(() => connection.getAccountInfo(VAULT, "confirmed")));
      for (const m of markets)
        if (SPLIT_MODES.has(m.mode)) {
          m.platformOwner = admin;
          m.platformQuote = getAssociatedTokenAddressSync(m.quoteMint, admin, true, TOKEN_2022_PROGRAM_ID);
        }
    } catch (e) {
      vaultError = `vault: ${errText(e)}`;
    }
  }

  // Everything the checks need, in as few calls as possible (100 accounts per call).
  const mints = [...new Set(markets.map((m) => m.quoteMint.toBase58()))].map(pk);
  const accountsOf = (m) => [m.pool, m.config, m.treasuryBase, m.treasuryQuote, m.payoutQuote, ...(m.platformQuote ? [m.platformQuote] : [])];
  const keys = [...new Map([payer.publicKey, ...mints, ...markets.flatMap(accountsOf)].map((k) => [k.toBase58(), k])).values()];
  const infos = [];
  for (let i = 0; i < keys.length; i += 100)
    infos.push(...(await rpc(() => connection.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed"))));
  const infoOf = new Map(keys.map((k, i) => [k.toBase58(), infos[i]]));
  const lookup = (k) => (k ? infoOf.get(k.toBase58()) : undefined);
  const balance = lookup(payer.publicKey)?.lamports ?? 0;
  // A dry run with an unfunded key simulates as each market's creator, a funded
  // wallet, so the programs still run. Simulation checks no signatures.
  const simulateAsCreator = dryRun && balance < 10_000;
  log(format("crank", { payer: payer.publicKey.toBase58(), lamports: balance, minAtoms, dryRun: dryRun ? 1 : 0, markets: listed.length }));
  if (!dryRun && balance < 10_000)
    throw Error(`Crank key ${payer.publicKey.toBase58()} has ${balance} lamports; fund it with Devnet SOL. Nothing sent.`);

  let latest = null;
  const blockhash = async () => {
    if (!latest || Date.now() - latest.at > 30_000)
      latest = { at: Date.now(), ...(await rpc(() => connection.getLatestBlockhash("confirmed"))) };
    return latest;
  };
  // `accounts`: addresses whose post-simulation state is returned (value.accounts).
  const simulate = async (step, feePayer, { accounts } = {}) => {
    const tx = new Transaction().add(...step.map((s) => s.ix));
    tx.feePayer = feePayer;
    tx.recentBlockhash = PublicKey.default.toBase58();
    const { value } = await rpc(() =>
      connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
        ...(accounts ? { accounts: { encoding: "base64", addresses: accounts.map((a) => a.toBase58()) } } : {}),
      }),
    );
    return value;
  };
  const send = async (step) => {
    const { blockhash: hash, lastValidBlockHeight } = await blockhash();
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash: hash, lastValidBlockHeight }).add(...step.map((s) => s.ix));
    tx.sign(payer);
    const raw = tx.serialize();
    let signature;
    try {
      signature = await rpc(() => connection.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 5 }));
    } catch (e) {
      return { ok: false, text: String(e?.transactionMessage ?? e?.message ?? e).slice(0, 300) };
    }
    for (let i = 0; i < 30; i++) {
      await sleep(confirmPollMs);
      const { value: [status] } = await rpc(() => connection.getSignatureStatuses([signature]));
      if (status?.err) return { ok: false, signature, ...describe(status.err, [], step) };
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized")
        return { ok: true, signature };
    }
    return { ok: false, signature, text: "not confirmed within 60 s; the next pass re-reads chain state" };
  };

  // Graduated markets: the Vault's DAMM v2 position that claim_graduated
  // collects from (cached in the ledger; one lookup for every uncached market).
  let graduated = new Map();
  try {
    graduated = await graduatedAccounts({ markets, infoOf: lookup, connection, rpc, ledger, log: (tag, fields) => log(format(tag, fields)) });
  } catch (e) {
    log(format("graduated", { action: "fail", reason: errText(e) }));
  }

  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    const base = { pool: m.pool.toBase58(), mode: m.mode };
    try {
      if (SPLIT_MODES.has(m.mode) && !m.platformQuote) throw Error(vaultError ?? "platform account unknown");
      const [pool, config, treasuryBase, treasuryQuote, payoutQuote] = accountsOf(m).map(lookup);
      const state = inspect(m, [pool, config, treasuryBase, treasuryQuote, payoutQuote, lookup(m.quoteMint), lookup(m.platformQuote)]);
      Object.assign(base, { fee: state.partnerQuoteFee, unallocated: state.unallocated, migrated: state.migrated ? 1 : undefined });
      const feePayer = simulateAsCreator ? m.creator : payer.publicKey;
      let graduatedNote;
      const g = graduated.get(base.pool);
      if (g?.error) graduatedNote = `claim_graduated: ${g.error}`;
      else if (g && state.treasuryBaseReady) {
        // What claim_graduated would move into the treasury now; nothing is sent for a zero.
        m.graduated = g;
        const probe = [
          { label: "compute budget", ix: ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }) },
          { label: "claim_graduated", ix: await claimGraduatedIx(m, g) },
        ];
        const r = await simulate(probe, feePayer, { accounts: [m.treasuryQuote] });
        if (r.err) graduatedNote = `claim_graduated would fail: ${describe(r.err, r.logs, probe).text}`;
        else state.graduatedFee = simulatedAmount(r.accounts?.[0], { owner: m.treasury, mint: m.quoteMint, program: TOKEN_2022_PROGRAM_ID }) - state.custody;
        base.graduatedFee = state.graduatedFee;
      }
      let plan = planMarket(state, minAtoms);
      if (!plan.claim && !plan.claimGraduated && !plan.distribute) {
        counts.skipped++;
        log(format("market", { ...base, action: "skip", reason: plan.reason, note: graduatedNote }));
        continue;
      }
      let steps = await buildSteps(m, plan, feePayer);
      let sim = await simulate(steps[0], feePayer);
      let note = [plan.reason, graduatedNote].filter(Boolean).join("; ") || undefined;
      // A claim that would fail (a migrated pool's DBC claim, say) is dropped:
      // the rest still runs, or the market is skipped when nothing is left.
      let skipped = false;
      for (let first = sim.err && describe(sim.err, sim.logs, steps[0]); first; first = sim.err && describe(sim.err, sim.logs, steps[0])) {
        const which = first.where === "claim" && plan.claim ? "claim" : first.where === "claim_graduated" && plan.claimGraduated ? "claimGraduated" : null;
        if (!which) break;
        plan = { ...plan, [which]: false };
        note = [note, `${first.where} would fail: ${first.text}`].filter(Boolean).join("; ");
        if (!plan.claim && !plan.claimGraduated && (state.unallocated <= 0n || !plan.distribute)) {
          counts.skipped++;
          log(format("market", { ...base, action: "skip", reason: `${first.where} would fail: ${first.text}` }));
          skipped = true;
          break;
        }
        steps = await buildSteps(m, plan, feePayer);
        sim = await simulate(steps[0], feePayer);
      }
      if (skipped) continue;
      const split = SPLIT_MODES.has(m.mode);
      const action = [plan.claim && "claim", plan.claimGraduated && "claim_graduated", plan.distribute && (split ? "distribute_split" : "distribute")].filter(Boolean).join("+");
      const extra = {
        action,
        payoutAta: plan.createPayout ? "create" : undefined,
        platformAta: plan.createPlatform ? "create" : undefined,
        bytes: steps.map((s) => txBytes(s.map((x) => x.ix), feePayer)).join(","),
        simPayer: simulateAsCreator ? "creator" : undefined,
      };
      if (sim.err) {
        counts.failed++;
        log(format("market", { ...base, ...extra, action: "fail", tried: action, reason: describe(sim.err, sim.logs, steps[0]).text, note }));
        continue;
      }
      if (dryRun) {
        counts.simulated++;
        // A split distribute depends on its claim landing first, so only the first step is simulated.
        log(format("market", { ...base, ...extra, result: "simulated", units: sim.unitsConsumed, steps: steps.length, note }));
        continue;
      }
      const signatures = [];
      let failure = null;
      for (const [n, step] of steps.entries()) {
        if (n > 0) {
          const again = await simulate(step, payer.publicKey);
          if (again.err) {
            failure = describe(again.err, again.logs, step).text;
            break;
          }
        }
        const r = await send(step);
        if (r.signature) signatures.push(r.signature);
        if (!r.ok) {
          failure = r.text;
          break;
        }
      }
      if (failure) {
        counts.failed++;
        log(format("market", { ...base, ...extra, action: "fail", tried: action, sig: signatures.join(",") || undefined, reason: failure, note }));
      } else {
        counts.sent++;
        log(format("market", { ...base, ...extra, result: "sent", sig: signatures.join(","), note }));
      }
    } catch (e) {
      counts.failed++;
      log(format("market", { ...base, action: "fail", reason: errText(e) }));
    }
  }

  // Reward tokens: after every market's claim/distribute, pass what the crank
  // key received for them on, by each market's fee module.
  const rewardMarkets = markets.filter((m) => m.payoutOwner.equals(payer.publicKey));
  let rewardLine = {};
  if (rewardMarkets.length) {
    // The DBC base vault is excluded from holders; inspect() sets it, unless the
    // market failed before reaching it (for example an unreadable Vault).
    for (const m of rewardMarkets)
      if (!m.baseVault) {
        try {
          m.baseVault = poolBaseVault(m, lookup(m.pool));
        } catch {
          // payRewards reports the market as not verified.
        }
      }
    const r = await payRewards({
      markets: rewardMarkets,
      authority: payer,
      connection,
      rpc,
      simulate,
      blockhash,
      ledger,
      readTreasury: rewardTotals,
      feePayerOf: (m) => (simulateAsCreator ? m.creator : payer.publicKey),
      minAtoms: rewardMinAtoms,
      dryRun,
      deadline: started + REWARD_BUDGET_MS,
      pollMs: confirmPollMs,
      log: (tag, fields) => log(format(tag, fields)),
      // No module ever pays the Vault (the crank key and the Vault admin are excluded too).
      excluded: [VAULT],
      fetchImpl,
    });
    counts.rewards = r;
    rewardLine = { rewardMarkets: r.markets, rewardTxs: r.txs, rewardAtoms: r.atoms, rewardFailed: r.failed };
  }

  // Graduation airdrops (indexer/modules/airdrop.mjs): any market whose DBC
  // config names this key as leftover receiver, once it has graduated.
  let airdropLine = {};
  const airdropJob = {
    markets,
    infoOf: lookup,
    authority: payer,
    connection,
    rpc,
    simulate,
    blockhash,
    ledger,
    dryRun,
    deadline: started + REWARD_BUDGET_MS,
    pollMs: confirmPollMs,
    log: (tag, fields) => log(format(tag, fields)),
    feePayerOf: (m) => (simulateAsCreator ? m.creator : payer.publicKey),
    excluded: [VAULT],
  };
  const airdropMarkets = markets.filter((m) => airdropReceiver(m, lookup)?.equals(payer.publicKey));
  if (airdropMarkets.length) {
    let r;
    if (!ledger) {
      r = { markets: airdropMarkets.length, txs: 0, atoms: 0n, failed: 0 };
      log(format("airdrop", { action: "skip", markets: airdropMarkets.length, reason: "DATABASE_URL not set; airdrops need the ledger" }));
    } else if (!(await ledger.ready().catch(() => false))) {
      r = { markets: airdropMarkets.length, txs: 0, atoms: 0n, failed: 0 };
      log(format("airdrop", { action: "skip", markets: airdropMarkets.length, reason: "ledger tables missing or out of date; restarting sonata-indexer (setup.sh does) creates them" }));
    } else r = await runAirdrops({ ...airdropJob, markets: airdropMarkets });
    counts.airdrops = r;
    airdropLine = { airdropMarkets: r.markets, airdropTxs: r.txs, airdropAtoms: r.atoms, airdropFailed: r.failed };
  }
  log(format("summary", { ...counts, rewards: undefined, airdrops: undefined, ...rewardLine, ...airdropLine, dryRun: dryRun ? 1 : 0, rpc: calls, ms: Date.now() - started }));
  return counts;
}

// The DBC config's leftover receiver, from this pass's accounts (null if unreadable).
function airdropReceiver(m, lookup) {
  const info = lookup(m.config);
  if (!info?.owner.equals(pk(dbc.program))) return null;
  try {
    return dbcCoder.decode("poolConfig", info.data).leftoverReceiver;
  } catch {
    return null;
  }
}

// Reads the key without ever echoing file contents (a JSON parse error quotes its input).
export function loadKeypair(path, log = console.log) {
  let bytes;
  try {
    bytes = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw Error(`Cannot read a Solana keypair JSON file at ${path}.`);
  }
  try {
    const keypair = Keypair.fromSecretKey(bytes);
    if (statSync(path).mode & 0o077) log(`warn: ${path} is readable by other users; chmod 600 it.`);
    return keypair;
  } catch {
    throw Error(`${path} is not a valid Solana keypair.`);
  }
}

async function main() {
  const env = process.env;
  const minRaw = env.CRANK_MIN_ATOMS ?? String(DEFAULT_MIN_ATOMS);
  if (!/^\d+$/.test(minRaw)) throw Error("CRANK_MIN_ATOMS must be a whole number of quote atoms.");
  const rewardMinRaw = env.REWARD_MIN_ATOMS ?? String(DEFAULT_REWARD_MIN_ATOMS);
  if (!/^\d+$/.test(rewardMinRaw)) throw Error("REWARD_MIN_ATOMS must be a whole number of quote atoms.");
  const payer = loadKeypair(env.CRANK_KEYPAIR || "/opt/sonata/crank-keypair.json");
  // Our own backoff handles the public RPC's rate limits.
  const connection = new Connection(env.SOLANA_RPC_URL || "https://api.devnet.solana.com", {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
  });
  // The reward ledger (the indexer's database). The pool connects only if a
  // reward market needs it.
  let db = null;
  if (env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2, connectionTimeoutMillis: 10_000 });
    db.on("error", (e) => console.log(`warn: reward ledger connection: ${errText(e)}`));
  }
  try {
    const counts = await runPass({
      connection,
      payer,
      minAtoms: BigInt(minRaw),
      dryRun: env.CRANK_DRY_RUN === "1",
      spacingMs: Number(env.CRANK_SPACING_MS || 500),
      ledger: db && pgLedger(db),
      rewardMinAtoms: BigInt(rewardMinRaw),
    });
    return counts.failed || counts.rewards?.failed || counts.airdrops?.failed ? 1 : 0;
  } finally {
    await db?.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(`crank aborted: ${errText(e)}`);
      process.exitCode = 1;
    },
  );
