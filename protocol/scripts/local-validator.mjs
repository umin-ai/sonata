// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { CREDIT_ID, ORACLE_ID } from "../sdk/client.mjs";
const path = resolve(
  "../.tools/stockroom/solana-release/bin/solana-test-validator",
);
// Each run gets a fresh, task-local ledger. Never reset another running validator's data.
const ledger = `target/validator-${Date.now()}`;
console.log(`Local-only validator: http://127.0.0.1:18899; ledger: ${ledger}`);
const child = spawn(
  existsSync(path) ? path : "solana-test-validator",
  [
    "--ledger",
    ledger,
    "--rpc-port",
    "18899",
    "--faucet-port",
    "18901",
    "--bind-address",
    "127.0.0.1",
    "--limit-ledger-size",
    "10000",
    "--bpf-program",
    CREDIT_ID.toBase58(),
    "target/deploy/stockroom_credit.so",
    "--bpf-program",
    ORACLE_ID.toBase58(),
    "target/deploy/demo_oracle.so",
    "--quiet",
  ],
  { stdio: "inherit" },
);
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
