import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { getTransactionDecoder } from "@solana/kit";
import {
  Keypair,
  PublicKey,
  Connection,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
const idl = JSON.parse(readFileSync("target/idl/stockroom_treasury.json")),
  id = new PublicKey(idl.address);

test("registration binds the DBC creator, config, mints and fee authority before custody exists", async () => {
  const { createDbcProgram } =
    await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const fixture = JSON.parse(readFileSync("tests/fixtures/treasury-dbc.json"));
  const svm = new LiteSVM();
  svm.addProgramFromFile(id.toBase58(), "target/deploy/stockroom_treasury.so");
  const creator = Keypair.generate(),
    attacker = Keypair.generate();
  for (const k of [creator, attacker])
    svm.airdrop(k.publicKey.toBase58(), 10_000_000_000n);
  const conn = new Connection("http://127.0.0.1:8899"),
    program = new anchor.Program(
      idl,
      new anchor.AnchorProvider(conn, new anchor.Wallet(creator), {}),
    ),
    dbc = createDbcProgram(conn).program;
  const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("stockroom")],
      id,
    ),
    pool = new PublicKey(fixture.pool.address),
    config = new PublicKey(fixture.config.address),
    [treasury] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), pool.toBuffer()],
      id,
    );
  const encode = (name, value) => {
    const info = dbc.coder.accounts.accountLayouts.get(name),
      buffer = Buffer.alloc(4096),
      size = info.layout.encode(value, buffer);
    return Buffer.concat([
      Buffer.from(info.discriminator),
      buffer.subarray(0, size),
    ]);
  };
  const decodedPool = dbc.coder.accounts.decode(
    "virtualPool",
    Buffer.from(fixture.pool.data, "base64"),
  );
  (decodedPool.poolState ?? decodedPool).creator = creator.publicKey;
  const decodedConfig = dbc.coder.accounts.decode(
    "poolConfig",
    Buffer.from(fixture.config.data, "base64"),
  );
  decodedConfig.feeClaimer = vault;
  const put = (row, data) =>
    svm.setAccount({
      address: row.address,
      programAddress: row.owner,
      lamports: BigInt(row.lamports),
      executable: false,
      data,
      space: BigInt(data.length),
    });
  for (const n of ["quoteMint", "baseMint"])
    put(fixture[n], Buffer.from(fixture[n].data, "base64"));
  put(fixture.pool, encode("virtualPool", decodedPool));
  put(fixture.config, encode("poolConfig", decodedConfig));
  async function send(ix, signer, error) {
    svm.expireBlockhash();
    const tx = new Transaction({
      feePayer: signer.publicKey,
      recentBlockhash: svm.latestBlockhash(),
    }).add(await ix);
    tx.sign(signer);
    const res = svm.sendTransaction(
      getTransactionDecoder().decode(tx.serialize()),
    );
    if (error) {
      assert(res instanceof FailedTransactionMetadata);
      assert.match(res.meta().logs().join("\n"), error);
      assert.equal(svm.getAccount(treasury.toBase58()).exists, false);
    } else if (res instanceof FailedTransactionMetadata)
      throw Error(res.meta().logs().join("\n"));
  }
  await send(
    program.methods
      .initVault()
      .accounts({
        vault,
        admin: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    creator,
  );
  const init = (who) =>
    program.methods
      .initTreasury({ duet: {} }, creator.publicKey)
      .accounts({
        vault,
        treasury,
        pool,
        config,
        quoteMint: new PublicKey(fixture.quoteMint.address),
        baseMint: new PublicKey(fixture.baseMint.address),
        creator: who.publicKey,
        payer: who.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  await send(init(attacker), attacker, /Unauthorized/);
  decodedConfig.feeClaimer = attacker.publicKey;
  put(fixture.config, encode("poolConfig", decodedConfig));
  await send(init(creator), creator, /InvalidPool/);
  decodedConfig.feeClaimer = vault;
  put(fixture.config, encode("poolConfig", decodedConfig));
  await send(init(creator), creator);
  assert.equal(svm.getAccount(treasury.toBase58()).exists, true);
});
