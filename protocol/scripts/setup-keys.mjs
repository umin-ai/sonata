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
if (process.argv.includes("--new-program-ids")) {
  for (const name of ["credit-program", "oracle-program"])
    if (existsSync(`.keys/${name}.json`))
      throw new Error("Refusing to replace existing program keys");
  const replacements = {
    "4sS8MrfTUjavLyMs5GtircsjMab5vfVZdLE7YPcZo9BH":
      key("credit-program").publicKey.toBase58(),
    E45Bq8CUh12Fncuyd5GMHKgkmjpVp8n2C7521ExryDwg:
      key("oracle-program").publicKey.toBase58(),
  };
  for (const file of [
    "Anchor.toml",
    "sdk/client.mjs",
    "programs/stockroom-credit/src/lib.rs",
    "programs/demo-oracle/src/lib.rs",
  ]) {
    let text = readFileSync(file, "utf8");
    for (const [oldId, newId] of Object.entries(replacements))
      text = text.replaceAll(oldId, newId);
    writeFileSync(file, text);
  }
  console.log("New program addresses:", Object.values(replacements).join(", "));
  console.log(
    "Rebuild and verify before deploying. Existing public sample receipts refer to the original program addresses.",
  );
}
