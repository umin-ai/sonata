// SPDX-License-Identifier: GPL-3.0-or-later
// Read-only. Compares each deployed Devnet program with the local build in
// target/deploy and reports its upgrade authority. Needs no keys and sends no
// transactions, so anyone can run it after `npm ci` and a local build.
//
// Method: an upgradeable program's ProgramData account holds a 45-byte header
// (4-byte state tag, 8-byte slot, 1-byte option, 32-byte authority) followed
// by the ELF, then zero padding up to the allocated length. We hash the ELF
// region equal to the local file's length and require the remainder to be
// zero. Both must hold for "matches".
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import assert from "node:assert/strict";

const PROGRAMS = [
  ["stockroom_treasury", "GPANv5zMEmvkVKQxJgLds2B4bEbnub6HhS2WQq71fjNj"],
  ["stockroom_rewards", "6u1nXj1iXNxCGThKetW45MSpXeEdn5GFw6NaZa4Mpn1L"],
];
const HEADER = 45;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(
  await conn.getGenesisHash(),
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "Not Devnet.",
);

const results = [];
for (const [name, id] of PROGRAMS) {
  const program = await conn.getAccountInfo(new PublicKey(id));
  assert.ok(program?.executable, `${name} is not an executable program`);
  const programData = new PublicKey(program.data.subarray(4, 36));
  const data = (await conn.getAccountInfo(programData)).data;
  const upgradeAuthority =
    data[12] === 1 ? new PublicKey(data.subarray(13, 45)).toBase58() : null;
  const elf = data.subarray(HEADER);

  const path = `target/deploy/${name}.so`;
  let local = null;
  if (existsSync(path)) {
    const file = readFileSync(path);
    const window = elf.subarray(0, file.length);
    const tailIsZero = elf.subarray(file.length).every((b) => b === 0);
    local = {
      path,
      bytes: file.length,
      sha256: sha256(file),
      deployedWindowSha256: sha256(window),
      tailIsZero,
      matches: tailIsZero && sha256(window) === sha256(file),
    };
  }
  results.push({ name, program: id, programData: programData.toBase58(), upgradeAuthority, local });
  const verdict = !local
    ? "no local build to compare (run the build first)"
    : local.matches
      ? "MATCHES local build"
      : "DOES NOT MATCH local build";
  console.log(
    `${name.padEnd(20)} ${verdict}\n  upgrade authority: ${upgradeAuthority ?? "none (immutable)"}${
      local ? `\n  local   ${local.sha256}\n  onchain ${local.deployedWindowSha256}` : ""
    }`,
  );
}

writeFileSync(
  "artifacts/deployed-bytes-check.json",
  JSON.stringify({ network: "solana:devnet", checkedAt: new Date().toISOString(), method: "sha256 of ProgramData bytes [45, 45 + local length), remainder required to be zero", results }, null, 2),
);
console.log("\nWrote artifacts/deployed-bytes-check.json");
