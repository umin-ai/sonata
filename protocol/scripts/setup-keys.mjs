// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
mkdirSync(".keys", { recursive: true, mode: 0o700 });
function key(name) {
  const file = `.keys/${name}.json`;
  if (!existsSync(file))
    writeFileSync(file, JSON.stringify([...Keypair.generate().secretKey]), {
      mode: 0o600,
      flag: "wx",
    });
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file))));
}
console.log(`Demo-only deployment wallet: ${key("deployer").publicKey}`);
