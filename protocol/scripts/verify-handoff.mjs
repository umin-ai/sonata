// SPDX-License-Identifier: GPL-3.0-or-later
// Read-only check of HANDOFF.md's evidence links:
//   - every Explorer link's label is the first and last 8 characters of its target;
//   - every transaction is finalized, and succeeded unless its table row is
//     marked "expected refusal" (then it must have failed);
//   - every account exists on Devnet;
//   - with --links, every other https link returns HTTP 200.
// Usage: node scripts/verify-handoff.mjs [--links] [HANDOFF.md]
import { readFileSync, writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import assert from "node:assert/strict";

const args = process.argv.slice(2);
const checkLinks = args.includes("--links");
const file = args.find((a) => !a.startsWith("--")) ?? "HANDOFF.md";
const text = readFileSync(file, "utf8");
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(await conn.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "Not Devnet.");

const re = /\[`([^`]+)`\]\((https:\/\/explorer\.solana\.com\/(tx|address)\/([1-9A-HJ-NP-Za-km-z]+)\?cluster=devnet)\)/g;
const lines = text.split("\n");
const lineOf = (index) => text.slice(0, index).split("\n").length;
const txs = new Map(), accounts = new Map(), labelErrors = [];
for (const m of text.matchAll(re)) {
  const [, label, , kind, id] = m;
  const line = lineOf(m.index);
  const short = `${id.slice(0, 8)}…${id.slice(-8)}`;
  if (label.includes("…") && label !== short) labelErrors.push({ line, label, expected: short });
  const expectFailure = /expected refusal/i.test(lines[line - 1]);
  const map = kind === "tx" ? txs : accounts;
  const prev = map.get(id);
  map.set(id, { line: prev?.line ?? line, expectFailure: prev?.expectFailure || expectFailure });
}

const txFailures = [];
const sigs = [...txs.keys()];
for (let i = 0; i < sigs.length; i += 200) {
  const batch = sigs.slice(i, i + 200);
  const { value } = await conn.getSignatureStatuses(batch, { searchTransactionHistory: true });
  value.forEach((st, j) => {
    const id = batch[j], { line, expectFailure } = txs.get(id);
    const ok = st?.confirmationStatus === "finalized" && (expectFailure ? st.err !== null : st.err === null);
    if (!ok) txFailures.push({ line, id, status: st?.confirmationStatus ?? "not found", err: st?.err ?? null, expectFailure });
  });
}

const accountFailures = [];
const ids = [...accounts.keys()];
for (let i = 0; i < ids.length; i += 100) {
  const batch = ids.slice(i, i + 100);
  const infos = await conn.getMultipleAccountsInfo(batch.map((a) => new PublicKey(a)));
  infos.forEach((info, j) => {
    if (!info) accountFailures.push({ line: accounts.get(batch[j]).line, id: batch[j] });
  });
}

const linkFailures = [];
let linksChecked = 0;
if (checkLinks) {
  const urls = new Set([...text.matchAll(/\((https:\/\/(?!explorer\.solana\.com)[^)\s]+)\)/g)].map((m) => m[1]));
  for (const url of urls) {
    linksChecked++;
    const res = await fetch(url, { method: "GET", redirect: "follow" }).catch((e) => ({ status: String(e) }));
    if (res.status !== 200) linkFailures.push({ url, status: res.status });
  }
}

const report = {
  file,
  checkedAt: new Date().toISOString(),
  transactions: txs.size,
  expectedRefusals: [...txs.values()].filter((t) => t.expectFailure).length,
  accounts: accounts.size,
  linksChecked,
  labelErrors,
  txFailures,
  accountFailures,
  linkFailures,
};
writeFileSync("artifacts/handoff-check.json", JSON.stringify(report, null, 2));
console.log(
  `${txs.size} transactions (${report.expectedRefusals} expected refusal), ${accounts.size} accounts${checkLinks ? `, ${linksChecked} links` : ""}: ` +
    `${labelErrors.length} label errors, ${txFailures.length} transaction failures, ${accountFailures.length} missing accounts` +
    (checkLinks ? `, ${linkFailures.length} broken links` : ""),
);
for (const e of [...labelErrors, ...txFailures, ...accountFailures, ...linkFailures]) console.log(e);
process.exitCode = labelErrors.length + txFailures.length + accountFailures.length + linkFailures.length ? 1 : 0;
