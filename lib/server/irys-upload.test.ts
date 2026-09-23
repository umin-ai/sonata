import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { createDataItem, encodeTags } from "./irys-upload.ts";

// Fixed Ed25519 key (seed of 32 sevens). The expected id was produced by the
// official @irys/bundles createData for the same key, data and tags, and the
// serialized bytes matched exactly.
const seed = Buffer.alloc(32, 7);
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
  format: "der",
  type: "pkcs8",
});
const publicKey = new Uint8Array(
  createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32),
);
const signer = {
  publicKey,
  sign: async (m: Uint8Array) => new Uint8Array(sign(null, m, privateKey)),
};

test("data items match the official Irys encoding", async () => {
  const data = new TextEncoder().encode(JSON.stringify({ name: "Sonata", symbol: "SNT" }));
  const { item, id } = await createDataItem(
    data,
    [{ name: "Content-Type", value: "application/json" }],
    signer,
  );
  assert.equal(id, "3G7ZUUC8ZNvkb654kqvRkgzkoVHCiW961J6q2DS7wLP4");
  // 2 type + 64 sig + 32 owner + 1 target + 1 anchor + 8 + 8 + tags + data.
  assert.equal(item.length, 116 + encodeTags([{ name: "Content-Type", value: "application/json" }]).length + data.length);
  assert.equal(item[0], 2);
});

test("tags use Avro zigzag varints with a zero terminator", () => {
  const t = encodeTags([{ name: "a", value: "bc" }]);
  assert.deepEqual([...t], [2, 2, 97, 4, 98, 99, 0]);
  assert.equal(encodeTags([]).length, 0);
});
