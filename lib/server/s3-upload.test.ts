import test from "node:test";
import assert from "node:assert/strict";
import { objectKey, s3Config } from "./s3-upload.ts";

test("object keys are the content's SHA-256", async () => {
  const key = await objectKey(new TextEncoder().encode("abc"), "metadata.json");
  assert.equal(key, "tokens/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad/metadata.json");
  await assert.rejects(objectKey(new Uint8Array(), "../x"), /Unexpected/);
});

test("storage is used only when fully configured", () => {
  assert.equal(s3Config({ AWS_REGION: "eu-west-1" }), null);
  const cfg = s3Config({
    AWS_REGION: "eu-west-1",
    SONATA_ASSETS_BUCKET: "b",
    SONATA_ASSETS_CDN: "https://d.cloudfront.net/",
    AWS_ACCESS_KEY_ID: "k",
    AWS_SECRET_ACCESS_KEY: "s",
  });
  assert.equal(cfg?.cdn, "https://d.cloudfront.net");
});
