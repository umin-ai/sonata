// Captures the Devnet accounts of four Sonata markets into
// lib/treasury/fixtures/devnet-markets.json, for the market-read tests. Read-only:
// it sends no transaction. Then it runs the app's own discoverMarkets and
// readTreasury against that capture (through fixtures/fake-rpc.ts) and stores
// their outputs as the fixture's "golden" answers, which the tests compare the
// batched readers against.
//
// The markets: the flagship ROOM (duet), a Floor market, a Reward token
// (Standard, paid by Sonata's bot) and a Backed token (Standard Floor).
//
//   node --experimental-strip-types --no-warnings --import ./scripts/test-register.mjs \
//     scripts/capture-market-fixture.mjs [rpc-url]
//
// The RPC defaults to SOLANA_RPC_URL, else public Devnet. Re-capturing replaces
// the goldens with what the current code answers: review that diff by hand.
import { writeFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import treasuryIdl from "../lib/treasury/stockroom_treasury.json" with { type: "json" };
import market from "../lib/treasury/market.json" with { type: "json" };

const RPC = process.argv[2] || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const OUT = new URL("../lib/treasury/fixtures/devnet-markets.json", import.meta.url);
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const REWARDS_WALLET = "Fb83XLPdUM11FrUUBNaB1JXJ2feJacNkcPGUzP8dtGz";
const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
// Anchor's order of the program's Mode enum.
const MODES = ["refrain", "duet", "sustain", "floor", "standard", "standardFloor"];
const DISCRIMINATOR = Buffer.from(treasuryIdl.accounts.find((a) => a.name === "Treasury").discriminator);

async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await r.json();
      if (!r.ok || body.error) throw Error(`${method}: ${r.status} ${JSON.stringify(body.error ?? body)}`);
      return body.result;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt));
    }
  }
}

if ((await rpc("getGenesisHash", [])) !== GENESIS) throw Error("Not Solana Devnet.");
const listed = await rpc("getProgramAccounts", [
  treasuryIdl.address,
  { encoding: "base64", commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: bs58.encode(DISCRIMINATOR) } }] },
]);
// The treasury's fixed layout after its 8-byte discriminator (see the IDL).
const decode = ({ pubkey, account }) => {
  const d = Buffer.from(account.data[0], "base64");
  const key = (offset) => new PublicKey(d.subarray(offset, offset + 32));
  return {
    treasury: new PublicKey(pubkey),
    pool: key(8),
    config: key(40),
    quoteMint: key(72),
    baseMint: key(104),
    payoutOwner: key(168),
    mode: MODES[d[200]],
  };
};
const all = listed.map((entry) => ({ entry, t: decode(entry) }));
const pick = (label, test) => {
  const found = all.find(({ t }) => test(t));
  if (!found) throw Error(`No ${label} market on Devnet.`);
  return found;
};
const chosen = [
  pick("ROOM", (t) => t.pool.toBase58() === market.pool),
  pick("Floor", (t) => t.mode === "floor"),
  pick("Reward", (t) => t.mode === "standard" && t.payoutOwner.toBase58() === REWARDS_WALLET),
  pick("Backed", (t) => t.mode === "standardFloor"),
];
const keys = new Set([treasuryIdl.address]);
for (const { t } of chosen) {
  for (const k of [
    t.pool,
    t.config,
    PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBuffer(), t.baseMint.toBuffer()], METAPLEX)[0],
    t.treasury,
    t.baseMint,
    getAssociatedTokenAddressSync(t.quoteMint, t.treasury, true, TOKEN_2022_PROGRAM_ID),
    getAssociatedTokenAddressSync(t.quoteMint, t.payoutOwner, true, TOKEN_2022_PROGRAM_ID),
    t.quoteMint,
  ])
    keys.add(k.toBase58());
}
const list = [...keys];
const read = await rpc("getMultipleAccounts", [list, { encoding: "base64", commitment: "confirmed" }]);
const fixture = {
  capturedAt: new Date().toISOString(),
  genesis: GENESIS,
  slot: read.context.slot,
  treasuryProgram: treasuryIdl.address,
  // Only the chosen markets' treasuries, as getProgramAccounts returned them.
  programAccounts: chosen.map(({ entry }) => entry),
  accounts: Object.fromEntries(list.map((k, i) => [k, read.value[i]])),
};

// Golden answers: the app's own readers, run against the capture.
const { fakeRpc } = await import("../lib/treasury/fixtures/fake-rpc.ts");
globalThis.fetch = fakeRpc(fixture);
const runtime = await import("../lib/treasury/runtime.ts");
const markets = await runtime.discoverMarkets();
const treasuries = {};
for (const m of markets) {
  const snapshot = await runtime.readTreasury(m);
  treasuries[m.pool] = snapshot;
}
fixture.golden = { markets, treasuries };
writeFileSync(OUT, JSON.stringify(fixture, null, 1) + "\n");
console.log(
  `Wrote ${fileLabel(OUT)}: ${markets.length} markets (${markets.map((m) => `${m.symbol} ${m.mode}`).join(", ")}), slot ${fixture.slot}, from ${new URL(RPC).host}.`,
);
function fileLabel(url) {
  return url.pathname.split("/web/")[1] ?? url.pathname;
}
