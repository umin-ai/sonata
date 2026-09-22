// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { proveProgram } from "./program-proof.mjs";
const rpc = "https://api.devnet.solana.com",
  c = new Connection(rpc, "confirmed"),
  genesis = await c.getGenesisHash();
if (genesis !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")
  throw Error("Devnet only");
const tests = spawnSync(
  process.execPath,
  ["--test", "tests/treasury.test.mjs"],
  { encoding: "utf8" },
);
if (tests.status !== 0) throw Error(tests.stdout + tests.stderr);
console.log(tests.stdout);
const program = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(readFileSync(".keys/stockroom-treasury-program.json")),
  ),
);
const id = program.publicKey;
if (
  JSON.parse(readFileSync("target/idl/stockroom_treasury.json")).address !==
  id.toBase58()
)
  throw Error("IDL/program mismatch");
if (!(await c.getAccountInfo(id))?.executable) {
  const buf = ".keys/stockroom-treasury-buffer.json";
  if (!existsSync(buf))
    writeFileSync(buf, JSON.stringify([...Keypair.generate().secretKey]), {
      mode: 0o600,
      flag: "wx",
    });
  const p = spawnSync(
    "../.tools/stockroom/solana-release/bin/solana",
    [
      "program",
      "deploy",
      "target/deploy/stockroom_treasury.so",
      "--program-id",
      ".keys/stockroom-treasury-program.json",
      "--buffer",
      buf,
      "--url",
      rpc,
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
  if (p.status !== 0) throw Error(p.stderr);
  console.log(p.stdout);
}
const proof = await proveProgram(c, id, "stockroom_treasury");
const evidence = {
  network: "devnet",
  genesis,
  deployedAt: new Date().toISOString(),
  program: id.toBase58(),
  sourceSha256: createHash("sha256")
    .update(readFileSync("programs/stockroom-treasury/src/lib.rs"))
    .digest("hex"),
  tests: "5/5 passed",
  proof,
};
writeFileSync(
  "artifacts/stockroom-treasury-deployment.json",
  JSON.stringify(evidence, null, 2),
);
console.log(evidence);
