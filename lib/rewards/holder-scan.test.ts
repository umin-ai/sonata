import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { scanHolderAccounts } from "./holder-scan.ts";
const mint = new PublicKey(new Uint8Array(32).fill(3)),
  a = new PublicKey(new Uint8Array(32).fill(4)),
  b = new PublicKey(new Uint8Array(32).fill(5));
const info = (data: Buffer) => ({
  data,
  owner: TOKEN_PROGRAM_ID,
  lamports: 1,
  executable: false,
  rentEpoch: 0,
});
function fixture(complete: boolean) {
  const md = Buffer.alloc(82);
  md.writeBigUInt64LE(100n, 36);
  md[44] = 6;
  md[45] = 1;
  const token = (n: bigint) => {
    const d = Buffer.alloc(165);
    mint.toBuffer().copy(d);
    a.toBuffer().copy(d, 32);
    d.writeBigUInt64LE(n, 64);
    d[108] = 1;
    return info(d);
  };
  return {
    getAccountInfo: async () => info(md),
    getProgramAccounts: async () => {
      throw Error("excluded from account secondary indexes");
    },
    getSignaturesForAddress: async () => [{ signature: "tx" }],
    getParsedTransaction: async () => ({
      transaction: { message: { accountKeys: [{ pubkey: a }, { pubkey: b }] } },
      meta: {
        postTokenBalances: [
          { mint: mint.toBase58(), accountIndex: 0 },
          ...(complete ? [{ mint: mint.toBase58(), accountIndex: 1 }] : []),
        ],
      },
    }),
    getMultipleAccountsInfoAndContext: async () => ({
      context: { slot: 100 },
      value: [info(md), token(25n), ...(complete ? [token(75n)] : [])],
    }),
  } as unknown as Connection;
}
test("history-derived candidates accepted only when same-response supply reconciles", async () => {
  const result = await scanHolderAccounts(fixture(true), mint.toBase58());
  assert.equal(result.value.length, 2);
  assert.equal(result.context.slot, 100);
});
test("missing holders cause a hard failure, never a partial payout", async () => {
  await assert.rejects(
    scanHolderAccounts(fixture(false), mint.toBase58()),
    /complete holder snapshot/,
  );
});
