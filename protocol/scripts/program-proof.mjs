// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
export async function proveProgram(connection, id, name) {
  const expected = readFileSync(`target/deploy/${name}.so`);
  const account = await connection.getAccountInfo(id, "confirmed");
  if (!account?.executable) throw new Error(`${name} is not executable`);
  const loader = account.owner.toBase58();
  let bytes = account.data;
  let dataAddress = null;
  if (loader === "BPFLoaderUpgradeab1e11111111111111111111111") {
    if (bytes.length !== 36 || bytes.readUInt32LE(0) !== 2)
      throw new Error("Invalid upgradeable Program state");
    const address = new PublicKey(bytes.subarray(4, 36));
    const data = await connection.getAccountInfo(address, "confirmed");
    if (
      !data ||
      !data.owner.equals(account.owner) ||
      data.data.readUInt32LE(0) !== 3
    )
      throw new Error("Invalid ProgramData state");
    // Solana loader-v3-interface 6.1.1, state.rs: size_of_programdata_metadata() == 45.
    bytes = data.data.subarray(45);
    dataAddress = address.toBase58();
  } else if (
    ![
      "BPFLoader2111111111111111111111111111111111",
      "BPFLoader1111111111111111111111111111111111",
    ].includes(loader)
  )
    throw new Error(`Unsupported loader ${loader}`);
  if (
    bytes.length < expected.length ||
    !bytes.subarray(0, expected.length).equals(expected) ||
    bytes.subarray(expected.length).some((value) => value !== 0)
  )
    throw new Error(
      `${name}: on-network bytes differ from the tested local binary`,
    );
  return {
    name,
    program: id.toBase58(),
    loader,
    programData: dataAddress,
    bytes: expected.length,
    sha256: createHash("sha256").update(expected).digest("hex"),
    exactBinaryMatch: true,
  };
}
