// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
mkdirSync("artifacts", { recursive: true });
const build = JSON.parse(readFileSync("artifacts/build.json"));
for (const [file, expected] of Object.entries(build.sources ?? {}))
  if (
    createHash("sha256").update(readFileSync(file)).digest("hex") !== expected
  )
    throw new Error("Source differs from build: " + file);
if (!build.sources)
  throw new Error("Run npm run build to record source hashes");
const checks = [
  ["format", "cargo", ["fmt", "--all", "--check"]],
  [
    "client-format",
    "node",
    [
      "node_modules/prettier/bin/prettier.cjs",
      "--check",
      "scripts/*.mjs",
      "sdk/*.mjs",
      "tests/*.mjs",
    ],
  ],
  ["math", "cargo", ["test", "--locked", "-p", "credit-math"]],
  ["sbf", "node", ["--test", "tests/credit.test.mjs"]],
];
const evidence = {
  checkedAt: new Date().toISOString(),
  result: "PASS",
  checks: [],
};
for (const [name, command, args] of checks) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, CARGO_BUILD_JOBS: "2" },
  });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  writeFileSync(`artifacts/${name}-verification.txt`, output);
  process.stdout.write(output);
  evidence.checks.push({ name, status: result.status });
  if (result.status !== 0) {
    evidence.result = "FAIL";
    writeFileSync(
      "artifacts/verification.json",
      JSON.stringify(evidence, null, 2) + "\n",
    );
    process.exit(result.status || 1);
  }
}
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
evidence.binaries = Object.fromEntries(
  ["stockroom_credit", "demo_oracle"].map((name) => [
    name,
    hash(`target/deploy/${name}.so`),
  ]),
);
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
  "sdk/client.mjs",
  "tests/credit.test.mjs",
  "tests/fixture.mjs",
  "package.json",
  "package-lock.json",
  ...readdirSync("scripts")
    .filter((name) => name.endsWith(".mjs"))
    .sort()
    .map((name) => `scripts/${name}`),
  ...readdirSync("sdk/idl")
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => `sdk/idl/${name}`),
];
evidence.sources = Object.fromEntries(
  sourceFiles.map((file) => [file, hash(file)]),
);
writeFileSync(
  "artifacts/verification.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
