// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
const bin = resolve("../.tools/stockroom");
const anchor = existsSync(resolve(bin, "anchor"))
  ? resolve(bin, "anchor")
  : "anchor";
const env = {
  ...process.env,
  PATH: resolve(bin, "solana-release/bin") + ":" + process.env.PATH,
  RUSTUP_TOOLCHAIN: "1.90.0",
  CARGO_BUILD_JOBS: "2",
  CARGO_PROFILE_DEV_DEBUG: "0",
};
function run(args) {
  const result = spawnSync(anchor, args, {
    encoding: "utf8",
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  if (
    result.status !== 0 ||
    /Stack offset .*exceeded max offset/.test(result.stderr ?? "")
  )
    process.exit(result.status || 1);
}
// Separate commands keep --locked correctly scoped to cargo build vs. cargo test.
run(["build", "--ignore-keys", "--no-idl", "--", "--", "--locked"]);
mkdirSync("sdk/idl", { recursive: true });
mkdirSync("target/types", { recursive: true });
mkdirSync("artifacts", { recursive: true });
const binaries = {};
for (const name of [
  "stockroom_credit",
  "demo_oracle",
  "stockroom_treasury",
  "stockroom_rewards",
]) {
  run([
    "idl",
    "build",
    "-p",
    name,
    "-o",
    `target/idl/${name}.json`,
    "-t",
    `target/types/${name}.ts`,
    "--",
    "--locked",
  ]);
  copyFileSync(`target/idl/${name}.json`, `sdk/idl/${name}.json`);
  binaries[name] = {
    sha256: createHash("sha256")
      .update(readFileSync(`target/deploy/${name}.so`))
      .digest("hex"),
    bytes: readFileSync(`target/deploy/${name}.so`).length,
  };
}
const sourceFiles = [
  "Cargo.toml",
  "Cargo.lock",
  "Anchor.toml",
  "rust-toolchain.toml",
  "crates/credit-math/Cargo.toml",
  "crates/credit-math/src/lib.rs",
  "programs/demo-oracle/Cargo.toml",
  "programs/demo-oracle/src/lib.rs",
  "programs/stockroom-credit/Cargo.toml",
  "programs/stockroom-credit/src/lib.rs",
  "programs/stockroom-treasury/Cargo.toml",
  "programs/stockroom-treasury/src/lib.rs",
  "programs/stockroom-rewards/Cargo.toml",
  "programs/stockroom-rewards/src/lib.rs",
];
const sources = Object.fromEntries(
  sourceFiles.map((file) => [
    file,
    createHash("sha256").update(readFileSync(file)).digest("hex"),
  ]),
);
writeFileSync(
  "artifacts/build.json",
  JSON.stringify(
    {
      sources,
      builtAt: new Date().toISOString(),
      anchor: "1.0.2",
      agave: "3.1.13",
      hostRust: "1.90.0",
      platformTools: "v1.52",
      binaries,
    },
    null,
    2,
  ) + "\n",
);
