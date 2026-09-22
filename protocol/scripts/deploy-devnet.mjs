// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Connection, Keypair } from "@solana/web3.js";
import {
  DEVNET_GENESIS,
  CREDIT_ID,
  ORACLE_ID,
  TREASURY_ID,
} from "../sdk/client.mjs";
import { proveProgram } from "./program-proof.mjs";
const rpc = "https://api.devnet.solana.com";
// QUIC sends upload chunks directly to validators instead of opening hundreds
// of connections to the public RPC. RPC remains an explicit fallback.
const transport = process.env.STOCKROOM_DEPLOY_TRANSPORT || "quic";
if (!["quic", "rpc"].includes(transport))
  throw new Error("STOCKROOM_DEPLOY_TRANSPORT must be quic or rpc");
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
for (const name of ["stockroom_credit", "demo_oracle", "stockroom_treasury"])
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
const previousPrograms = existsSync("artifacts/devnet-deployment.json")
  ? JSON.parse(readFileSync("artifacts/devnet-deployment.json")).programs
  : [];
const evidence = {
  network: "devnet",
  genesis: DEVNET_GENESIS,
  startedAt: new Date().toISOString(),
  deployer: key.publicKey.toBase58(),
  transport,
  programs: [],
};
for (const [name, id, keyFile] of [
  ["demo_oracle", ORACLE_ID, ".keys/oracle-program.json"],
  ["stockroom_credit", CREDIT_ID, ".keys/credit-program.json"],
  ["stockroom_treasury", TREASURY_ID, ".keys/stockroom-treasury-program.json"],
]) {
  const programKey = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(keyFile))),
  );
  if (!programKey.publicKey.equals(id))
    throw new Error(`${name} deployment key mismatch`);
  if ((await connection.getAccountInfo(id))?.executable) {
    // A resumed deployment must not upload or charge rent twice. A different
    // deployed binary is an error, not permission to silently overwrite it.
    const proof = await proveProgram(connection, id, name);
    const previous = previousPrograms.find((p) => p.id === id.toBase58());
    evidence.programs.push({
      name,
      id: id.toBase58(),
      sha256: verification.binaries[name],
      executable: true,
      ...(previous?.response ? { response: previous.response } : {}),
      reused: true,
      proof,
    });
    console.log(`Verified existing ${name}: ${id}`);
    continue;
  }
  // A fixed private buffer avoids the CLI printing a recovery seed on a failed upload.
  const bufferFile = resolve(`.keys/${name}-deploy-buffer.json`);
  if (!existsSync(bufferFile))
    writeFileSync(
      bufferFile,
      JSON.stringify([...Keypair.generate().secretKey]),
      { mode: 0o600, flag: "wx" },
    );
  const binary = readFileSync(`target/deploy/${name}.so`);
  const bufferKey = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(bufferFile))),
  ).publicKey;
  const buffer = await connection.getAccountInfo(bufferKey);
  // Upgradeable-loader Buffer metadata: enum u32 + Option<Pubkey> (33 bytes).
  if (
    buffer &&
    (buffer.owner.toBase58() !==
      "BPFLoaderUpgradeab1e11111111111111111111111" ||
      buffer.data.length < 37 ||
      buffer.data.readUInt32LE(0) !== 1 ||
      buffer.data[4] !== 1 ||
      !buffer.data.subarray(5, 37).equals(key.publicKey.toBuffer()))
  )
    throw new Error(`${name}: deployment buffer owner or authority mismatch`);
  const completeBuffer = buffer?.data.subarray(37).equals(binary) ?? false;
  const rent = await connection.getMinimumBalanceForRentExemption(
    binary.length + 45,
  );
  const estimate = Math.max(0, rent - (buffer?.lamports ?? 0)) + 100_000_000;
  const balance = await connection.getBalance(key.publicKey);
  if (balance < estimate)
    throw new Error(
      `${name}: need approximately ${(estimate / 1e9).toFixed(2)} additional Devnet SOL; wallet has ${(balance / 1e9).toFixed(3)}. Existing buffer rent is credited.`,
    );
  const result = spawnSync(
    solana,
    [
      "program",
      "deploy",
      // An interrupted upload can already contain the complete binary. Finalize
      // that verified buffer rather than resending writes marked AlreadyProcessed.
      ...(completeBuffer ? [] : [`target/deploy/${name}.so`]),
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
      `--use-${completeBuffer ? "rpc" : transport}`,
      "--commitment",
      "confirmed",
      "--output",
      "json",
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    writeFileSync(`.keys/${name}-deploy-stderr.log`, result.stderr ?? "", {
      mode: 0o600,
    });
    process.stderr.write(
      (result.stderr ?? "").split("\n").slice(-8).join("\n"),
    );
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
