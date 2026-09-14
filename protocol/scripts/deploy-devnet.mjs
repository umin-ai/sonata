// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Connection, Keypair } from "@solana/web3.js";
import { DEVNET_GENESIS, CREDIT_ID, ORACLE_ID } from "../sdk/client.mjs";
import { proveProgram } from "./program-proof.mjs";
const rpc = "https://api.devnet.solana.com";
const connection = new Connection(rpc, "confirmed");
if ((await connection.getGenesisHash()) !== DEVNET_GENESIS)
  throw new Error("Refusing to deploy outside Solana Devnet");
const verification = JSON.parse(readFileSync("artifacts/verification.json"));
if (verification.result !== "PASS") throw new Error("Run npm run verify first");
for (const [file, expected] of Object.entries(verification.sources))
  if (
    createHash("sha256").update(readFileSync(file)).digest("hex") !== expected
  )
    throw new Error(`Source changed after verification: ${file}`);
for (const name of ["stockroom_credit", "demo_oracle"])
  if (
    createHash("sha256")
      .update(readFileSync(`target/deploy/${name}.so`))
      .digest("hex") !== verification.binaries[name]
  )
    throw new Error(`Unverified binary: ${name}`);
const wallet = resolve(".keys/deployer.json");
const key = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(wallet))),
);
const solana = existsSync(
  resolve("../.tools/stockroom/solana-release/bin/solana"),
)
  ? resolve("../.tools/stockroom/solana-release/bin/solana")
  : "solana";
const balance = await connection.getBalance(key.publicKey);
const estimate =
  (
    await Promise.all(
      ["stockroom_credit", "demo_oracle"].map((name) =>
        connection.getMinimumBalanceForRentExemption(
          readFileSync(`target/deploy/${name}.so`).length + 45,
        ),
      ),
    )
  ).reduce((a, b) => a + b, 0) + 100_000_000;
if (balance < estimate)
  throw new Error(
    `Need approximately ${(estimate / 1e9).toFixed(2)} Devnet SOL; wallet ${key.publicKey} has ${(balance / 1e9).toFixed(3)}. Test tokens only.`,
  );
const evidence = {
  network: "devnet",
  genesis: DEVNET_GENESIS,
  startedAt: new Date().toISOString(),
  deployer: key.publicKey.toBase58(),
  programs: [],
};
for (const [name, id, keyFile] of [
  ["demo_oracle", ORACLE_ID, ".keys/oracle-program.json"],
  ["stockroom_credit", CREDIT_ID, ".keys/credit-program.json"],
]) {
  const programKey = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(keyFile))),
  );
  if (!programKey.publicKey.equals(id))
    throw new Error(`${name} deployment key mismatch`);
  // A fixed private buffer avoids the CLI printing a recovery seed on a failed upload.
  const bufferFile = resolve(`.keys/${name}-deploy-buffer.json`);
  if (!existsSync(bufferFile))
    writeFileSync(
      bufferFile,
      JSON.stringify([...Keypair.generate().secretKey]),
      { mode: 0o600, flag: "wx" },
    );
  const result = spawnSync(
    solana,
    [
      "program",
      "deploy",
      `target/deploy/${name}.so`,
      "--program-id",
      resolve(keyFile),
      "--buffer",
      bufferFile,
      "--url",
      rpc,
      "--keypair",
      wallet,
      "--fee-payer",
      wallet,
      "--upgrade-authority",
      wallet,
      "--use-rpc",
      "--commitment",
      "confirmed",
      "--output",
      "json",
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(
      `${name} deployment failed; the buffer key remains private for retry`,
    );
  }
  const response = JSON.parse(result.stdout);
  const executable = (await connection.getAccountInfo(id))?.executable;
  if (!executable) throw new Error(`${name} not executable after deploy`);
  evidence.programs.push({
    name,
    id: id.toBase58(),
    sha256: verification.binaries[name],
    executable,
    response,
    proof: await proveProgram(connection, id, name),
  });
  writeFileSync(
    "artifacts/devnet-deployment.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(`Deployed ${name}: ${id}`);
}
evidence.completedAt = new Date().toISOString();
writeFileSync(
  "artifacts/devnet-deployment.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
