import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { parseGrants } from "./allocations.ts";
const a = "ACbRB4yPfUikHAaXhWzJXH4pjSPf6rk82Jot1JqRQ3Ft",
  b = "F7w1MUYY9NH6WRRguxJdyWkmFRRmXWs5KraosRW8L4VQ";
test("member allocations preserve mock-stock atoms and accept explicit rows", () => {
  assert.deepEqual(parseGrants(`${a} 0.0000004\n${b},0.0000006`), [
    { recipient: a, amount: "40" },
    { recipient: b, amount: "60" },
  ]);
});
test("duplicate, ambiguous, empty, zero and over-precision promises are rejected", () => {
  for (const s of [
    "",
    `${a} 0`,
    `${a} 0.000000001`,
    `${a} 1 extra`,
    `${a} 1\n${a} 2`,
  ])
    assert.throws(() => parseGrants(s));
});
test("a PDA with no signing key cannot receive an irreversible grant", () => {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("test")],
    new PublicKey(a),
  );
  assert.throws(() => parseGrants(`${pda.toBase58()} 1`));
});
