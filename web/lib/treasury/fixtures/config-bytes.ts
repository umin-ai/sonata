// Test-only: edits one u8 field of a captured Meteora DBC config account.
import dbcIdl from "../dbc.json" with { type: "json" };
import { browserAnchor } from "../anchor.mjs";

const { BorshAccountsCoder } = browserAnchor as typeof import("@coral-xyz/anchor");
const dbcCoder = new BorshAccountsCoder(dbcIdl as never);

/**
 * The config bytes with `field` set to `value`. The field's offset is found by
 * trying each byte (the anchor coder cannot re-encode accounts over 1000 bytes).
 */
export function setConfigByte(data: Buffer, field: string, value: number) {
  const before = dbcCoder.decode("poolConfig", data) as Record<string, unknown>;
  for (let i = 8; i < data.length; i++) {
    if (data[i] !== before[field]) continue;
    const copy = Buffer.from(data);
    copy[i] = value;
    try {
      const after = dbcCoder.decode("poolConfig", copy) as Record<string, unknown>;
      if (after[field] === value) return copy;
    } catch {
      /* not this byte */
    }
  }
  throw Error(`no byte for ${field}`);
}
