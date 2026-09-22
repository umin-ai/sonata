// Devnet-only, bounded test grant. No key is sent to the frontend.
import { readFileSync, writeFileSync } from "node:fs";
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  unpackAccount,
} from "@solana/spl-token";
const owner = new PublicKey(process.argv[2]);
if (!PublicKey.isOnCurve(owner.toBytes()))
  throw Error("Signing wallet required.");
const m = JSON.parse(readFileSync("../cash-access/lib/treasury/market.json"));
const c = new Connection("https://api.devnet.solana.com", "confirmed");
if (
  (await c.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
)
  throw Error("Wrong network");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(".keys/deployer.json"))),
);
if (owner.equals(payer.publicKey)) throw Error("Use a separate test wallet.");
const mint = new PublicKey(m.quoteMint),
  source = getAssociatedTokenAddressSync(
    mint,
    payer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  ),
  destination = getAssociatedTokenAddressSync(
    mint,
    owner,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
const [balance, ata] = await Promise.all([
  c.getBalance(owner),
  c.getAccountInfo(destination),
]);
const held = ata
  ? unpackAccount(destination, ata, TOKEN_2022_PROGRAM_ID).amount
  : 0n;
const grant = held < 5000000n ? 5000000n - held : 0n;
const tx = new Transaction();
if (balance < 30000000)
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: owner,
      lamports: 30000000 - balance,
    }),
  );
if (grant > 0n)
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      destination,
      owner,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
    createTransferCheckedInstruction(
      source,
      mint,
      destination,
      payer.publicKey,
      grant,
      8,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );
if (!tx.instructions.length) {
  console.log("Test wallet already funded.");
  process.exit(0);
}
const signature = await sendAndConfirmTransaction(c, tx, [payer], {
  commitment: "confirmed",
});
const evidence = {
  network: "devnet",
  wallet: owner.toBase58(),
  signature,
  grantRaw: grant.toString(),
  createdAt: new Date().toISOString(),
};
writeFileSync(
  "artifacts/stockroom-trader-funding.json",
  JSON.stringify(evidence, null, 2),
);
console.log(evidence);
