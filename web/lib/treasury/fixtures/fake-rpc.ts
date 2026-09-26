// A JSON-RPC endpoint that answers from a captured fixture (devnet-markets.json),
// for tests and for recording golden outputs. Test-only; the app never imports it.
// It answers getGenesisHash, getProgramAccounts on the treasury program, and
// getMultipleAccounts / getAccountInfo for captured keys. Anything else, or a
// key that was not captured, gets a JSON-RPC error, so a read the fixture does
// not cover fails loudly instead of looking like a missing account.
import { Connection } from "@solana/web3.js";

export type RawAccount = {
  data: [string, "base64"];
  executable: boolean;
  lamports: number;
  owner: string;
  rentEpoch?: number;
  space?: number;
};
export type Fixture = {
  capturedAt: string;
  genesis: string;
  slot: number;
  treasuryProgram: string;
  programAccounts: { pubkey: string; account: RawAccount }[];
  accounts: Record<string, RawAccount | null>;
  /** Outputs of discoverMarkets and readTreasury recorded before the market-read refactor. */
  golden?: { markets: unknown[]; treasuries: Record<string, unknown> };
};
export type Call = { method: string; keys?: number };

export function fakeRpc(
  fixture: Fixture,
  { calls, accounts = fixture.accounts, programAccounts = fixture.programAccounts, slots = [] }: {
    calls?: Call[];
    accounts?: Record<string, RawAccount | null>;
    programAccounts?: Fixture["programAccounts"];
    /** The slot each getMultipleAccounts call answers at, in order (default: the fixture's). */
    slots?: number[];
  } = {},
): typeof fetch {
  let multiple = 0;
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { id: unknown; method: string; params?: unknown[] };
    const params = request.params ?? [];
    // new Response rather than Response.json: a polyfill loaded with the app's
    // Solana libraries can replace the global Response with one that lacks it.
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    const answer = (result: unknown) => json({ jsonrpc: "2.0", id: request.id, result });
    const refuse = (message: string) => json({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message } });
    const context = { slot: fixture.slot };
    const lookup = (key: string) => {
      if (!Object.hasOwn(accounts, key)) throw Error(`not in fixture: ${key}`);
      return accounts[key];
    };
    try {
      switch (request.method) {
        case "getGenesisHash":
          calls?.push({ method: request.method });
          return answer(fixture.genesis);
        case "getProgramAccounts": {
          calls?.push({ method: request.method });
          if (params[0] !== fixture.treasuryProgram) return refuse(`no program accounts for ${String(params[0])}`);
          const config = (params[1] ?? {}) as { withContext?: boolean };
          return answer(config.withContext ? { context, value: programAccounts } : programAccounts);
        }
        case "getMultipleAccounts": {
          const keys = params[0] as string[];
          calls?.push({ method: request.method, keys: keys.length });
          const slot = slots[multiple++] ?? fixture.slot;
          return answer({ context: { slot }, value: keys.map(lookup) });
        }
        case "getAccountInfo":
          calls?.push({ method: request.method, keys: 1 });
          return answer({ context, value: lookup(params[0] as string) });
        default:
          calls?.push({ method: request.method });
          return refuse(`method not in fixture: ${request.method}`);
      }
    } catch (e) {
      return refuse(e instanceof Error ? e.message : String(e));
    }
  }) as typeof fetch;
}

/** A web3.js Connection whose every call goes to fakeRpc(fixture). */
export function fakeConnection(fixture: Fixture, options: Parameters<typeof fakeRpc>[1] = {}) {
  return new Connection("http://fixture.invalid", {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: fakeRpc(fixture, options),
  });
}
