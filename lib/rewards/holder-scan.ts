import { PublicKey, type Connection } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
/** Return a complete balance set or fail closed. Never a top-holders approximation. */
export async function scanHolderAccounts(c: Connection, mintAddress: string) {
  const mint = new PublicKey(mintAddress),
    info = await c.getAccountInfo(mint);
  if (
    !info ||
    (!info.owner.equals(TOKEN_PROGRAM_ID) &&
      !info.owner.equals(TOKEN_2022_PROGRAM_ID))
  )
    throw Error("Unsupported community mint.");
  const program = info.owner;
  try {
    return {
      ...(await c.getProgramAccounts(program, {
        commitment: "confirmed",
        withContext: true,
        filters: [{ memcmp: { offset: 0, bytes: mintAddress } }],
      })),
      program,
    };
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes("secondary indexes"))
      throw e;
  }
  // Public RPC disables mint indexing. Discover candidate accounts from recent
  // mint transactions, then prove completeness by reconciling all balances with
  // mint supply in ONE getMultipleAccounts response. History is only discovery.
  const history = await c.getSignaturesForAddress(mint, { limit: 100 });
  const candidates = new Map<string, PublicKey>();
  async function reconcile() {
    if (!candidates.size) return null;
    if (candidates.size > 99)
      throw Error(
        "Indexed RPC required for this holder set. No partial distribution is allowed.",
      );
    const keys = [...candidates.values()];
    const all = await c.getMultipleAccountsInfoAndContext(
      [mint, ...keys],
      "confirmed",
    );
    const supply = unpackMint(mint, all.value[0], program).supply;
    const value = keys.flatMap((pubkey, i) => {
      const account = all.value[i + 1];
      if (!account || !account.owner.equals(program)) return [];
      try {
        const a = unpackAccount(pubkey, account, program);
        return a.mint.equals(mint) ? [{ pubkey, account }] : [];
      } catch {
        return [];
      }
    });
    const sum = value.reduce(
      (s, a) => s + unpackAccount(a.pubkey, a.account, program).amount,
      0n,
    );
    return sum === supply ? { context: all.context, value, program } : null;
  }
  for (let i = 0; i < history.length; i++) {
    const tx = await c.getParsedTransaction(history[i].signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    for (const b of [
      ...(tx?.meta?.preTokenBalances ?? []),
      ...(tx?.meta?.postTokenBalances ?? []),
    ])
      if (b.mint === mintAddress) {
        const key = tx!.transaction.message.accountKeys[b.accountIndex]?.pubkey;
        if (key) candidates.set(key.toBase58(), key);
      }
    if ((i + 1) % 5 === 0 || i === history.length - 1) {
      const complete = await reconcile();
      if (complete) return complete;
    }
  }
  throw Error(
    "Public RPC could not prove a complete holder snapshot. An indexed RPC is required; no holders were omitted.",
  );
}
