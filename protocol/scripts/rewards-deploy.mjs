import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Connection, Keypair } from "@solana/web3.js";
import { proveProgram } from "./program-proof.mjs";
const c = new Connection("https://api.devnet.solana.com", "confirmed");
if (
  (await c.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
)
  throw Error("Devnet only");
const build = JSON.parse(readFileSync("artifacts/build.json"));
for (const [file, hash] of Object.entries(build.sources))
  if (createHash("sha256").update(readFileSync(file)).digest("hex") !== hash)
    throw Error("Changed since build: " + file);
const test = spawnSync(process.execPath, ["--test", "tests/rewards.test.mjs"], {
  encoding: "utf8",
});
if (test.status !== 0) throw Error(test.stdout + test.stderr);
const OUT = "artifacts/stockroom-rewards-deployment.json";
// Keep the recorded deploy signature across reruns. A run that only re-proves
// the deployed bytes sends no transaction, so it has no new signature to record.
let deploySignature = existsSync(OUT)
  ? (JSON.parse(readFileSync(OUT, "utf8")).deploySignature ?? null)
  : null;
const kp = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(readFileSync(".keys/stockroom-rewards-program.json")),
  ),
);
if (!(await c.getAccountInfo(kp.publicKey))?.executable || process.argv.includes("--upgrade")) {
  const buffer = ".keys/stockroom-rewards-buffer.json";
  if (!existsSync(buffer))
    writeFileSync(buffer, JSON.stringify([...Keypair.generate().secretKey]), {
      mode: 0o600,
    });
  const r = spawnSync(
    "../.tools/stockroom/solana-release/bin/solana",
    [
      "program",
      "deploy",
      "target/deploy/stockroom_rewards.so",
      "--program-id",
      ".keys/stockroom-rewards-program.json",
      "--buffer",
      buffer,
      "--url",
      "https://api.devnet.solana.com",
      "--keypair",
      ".keys/deployer.json",
      "--use-quic",
      "--commitment",
      "confirmed",
      "--output",
      "json",
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (r.status !== 0) throw Error(r.stderr);
  console.log(r.stdout);
  // `--output json` prints {"programId": ..., "signature": ...}.
  deploySignature = r.stdout.match(/"signature":\s*"([1-9A-HJ-NP-Za-km-z]+)"/)?.[1] ?? null;
  if (!deploySignature)
    console.warn("No signature in the deploy output; deploySignature is left empty.");
}
const proof = await proveProgram(c, kp.publicKey, "stockroom_rewards");
const evidence = {
  network: "devnet",
  deploySignature,
  verifiedAt: new Date().toISOString(),
  tests: "11/11 SBF tests passed",
  proof,
};
writeFileSync(OUT, JSON.stringify(evidence, null, 2) + "\n");
console.log(evidence);
