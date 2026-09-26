import { PublicKey } from "@solana/web3.js";
import { parseUnits } from "../treasury/units.ts";
const pk = (s: string) => new PublicKey(s);
export type Grant = { recipient: string; amount: string };
export function parseGrants(text: string): Grant[] {
  const rows = text
    .trim()
    .split("\n")
    .filter((r) => r.trim())
    .map((row) => {
      const parts = row.trim().split(/[\s,]+/);
      if (parts.length !== 2)
        throw Error("Use one wallet address and mSPY amount per line.");
      const recipient = pk(parts[0]);
      if (!PublicKey.isOnCurve(recipient.toBytes()))
        throw Error("Recipients must be signing wallets.");
      return {
        recipient: recipient.toBase58(),
        amount: parseUnits(parts[1], 8).toString(),
      };
    });
  if (
    !rows.length ||
    rows.length > 8 ||
    new Set(rows.map((r) => r.recipient)).size !== rows.length
  )
    throw Error("Choose 1–8 different recipients with positive amounts.");
  return rows;
}
