import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
const market = JSON.parse(
  readFileSync(new URL("./market.json", import.meta.url), "utf8"),
);
const idl = JSON.parse(
  readFileSync(new URL("./stockroom_treasury.json", import.meta.url), "utf8"),
);
test("Sonata uses its independently deployed program, ROOM mint and pool", () => {
  assert.equal(market.network, "devnet");
  assert.equal(
    market.programId,
    "GPANv5zMEmvkVKQxJgLds2B4bEbnub6HhS2WQq71fjNj",
  );
  assert.equal(market.pool, "BZVxHsS8DQAkigYvQAPfssFGZRVSuWSYHrYQn2QmeFSf");
  assert.equal(market.baseMint, "3Hwo2RGJpHQfVd5BW92423uU5gomnhQRxDm7PZnfS8Js");
  assert.equal(idl.address, market.programId);
  assert.equal(idl.metadata.name, "stockroom_treasury");
});
test("custody addresses derive from the Sonata program and pinned recipients", () => {
  const program = new PublicKey(market.programId);
  const pool = new PublicKey(market.pool);
  assert.equal(
    PublicKey.findProgramAddressSync(
      [Buffer.from("stockroom")],
      program,
    )[0].toBase58(),
    market.vault,
  );
  const treasury = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), pool.toBytes()],
    program,
  )[0];
  assert.equal(treasury.toBase58(), market.treasury);
  assert.equal(
    getAssociatedTokenAddressSync(
      new PublicKey(market.quoteMint),
      treasury,
      true,
      TOKEN_2022_PROGRAM_ID,
    ).toBase58(),
    market.treasuryQuote,
  );
  assert.equal(
    getAssociatedTokenAddressSync(
      new PublicKey(market.baseMint),
      treasury,
      true,
      TOKEN_PROGRAM_ID,
    ).toBase58(),
    market.treasuryBase,
  );
  assert.equal(
    getAssociatedTokenAddressSync(
      new PublicKey(market.quoteMint),
      new PublicKey(market.payoutOwner),
      false,
      TOKEN_2022_PROGRAM_ID,
    ).toBase58(),
    market.payoutQuote,
  );
});
