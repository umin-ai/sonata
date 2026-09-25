import test from "node:test";
import assert from "node:assert/strict";
import { floorShare, floorPerMillion, pendingFloor } from "./floor.ts";

test("matches the program's share: floor * burned / supply, rounded down", () => {
  assert.equal(floorShare(500n, 250n, 1000n), 125n);
  assert.equal(floorShare(500n, 3n, 1000n), 1n);
  assert.equal(floorShare(500n, 1n, 1000n), 0n);
});

test("reproduces the Devnet Stock Floor proof", () => {
  // artifacts/stock-floor-proof.json in sonata-protocol.
  assert.equal(
    floorShare(2_400_000n, 117_600_268_266_952n, 1_000_000_000_000_000n),
    282_240n,
  );
});

test("never pays more than the floor and handles empty inputs", () => {
  assert.equal(floorShare(500n, 5000n, 1000n), 500n);
  assert.equal(floorShare(0n, 10n, 1000n), 0n);
  assert.equal(floorShare(500n, 10n, 0n), 0n);
});

test("floor per million tokens on a one-billion supply", () => {
  // 0.024 mQQQ floor over 1B tokens: 1M tokens are backed by 2,400 units.
  assert.equal(floorPerMillion(2_400_000n, 1_000_000_000_000_000n), 2_400n);
});

test("pending floor is the retained half of the next split", () => {
  assert.equal(pendingFloor(4_800_000n, 0n), 2_400_000n);
  assert.equal(pendingFloor(3n, 0n), 2n);
  assert.equal(pendingFloor(0n, 0n), 0n);
});

test("Backed tokens add a quarter, rounded down, as distribute_split does", () => {
  assert.equal(pendingFloor(4_000_000n, 800_000n, "standardFloor"), 1_200_000n);
  assert.equal(pendingFloor(3n, 0n, "standardFloor"), 0n);
  assert.equal(pendingFloor(7n, 0n, "standardFloor"), 1n);
});
