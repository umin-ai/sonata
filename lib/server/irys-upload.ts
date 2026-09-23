// Minimal Irys (Arweave ANS-104) uploader using only WebCrypto, so it runs in
// the app's Workers runtime. Builds an Ed25519-signed data item (signature type
// 2, the Solana signer) and posts it to the Irys devnet bundler. Items under
// ~100 KB are free, so a throwaway key signs each upload and nothing is funded.
// Format: https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md
// Verified byte-for-byte against @irys/bundles createData with a fixed key, and
// by a live upload whose returned id matched the one computed here.
export const IRYS_DEVNET = "https://devnet.irys.xyz";
const SIG_TYPE_ED25519 = 2;
const enc = new TextEncoder();

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const sha = async (alg: "SHA-256" | "SHA-384", data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest(alg, data as BufferSource));

// Arweave deep hash (SHA-384) over blobs and lists.
async function deepHash(data: Uint8Array | Uint8Array[]): Promise<Uint8Array> {
  if (Array.isArray(data)) {
    let acc = await sha("SHA-384", enc.encode(`list${data.length}`));
    for (const chunk of data)
      acc = await sha("SHA-384", concat(acc, await deepHash(chunk)));
    return acc;
  }
  const tag = await sha("SHA-384", enc.encode(`blob${data.byteLength}`));
  return sha("SHA-384", concat(tag, await sha("SHA-384", data)));
}

// Avro encoding of the tag array: zigzag varint count, then length-prefixed
// name/value bytes, then a zero terminator.
function varint(n: number) {
  let z = n * 2; // zigzag for non-negative values
  const out: number[] = [];
  while (z >= 0x80) {
    out.push((z & 0x7f) | 0x80);
    z = Math.floor(z / 128);
  }
  out.push(z);
  return Uint8Array.from(out);
}
export function encodeTags(tags: { name: string; value: string }[]) {
  if (!tags.length) return new Uint8Array();
  const parts: Uint8Array[] = [varint(tags.length)];
  for (const t of tags)
    for (const s of [t.name, t.value]) {
      const b = enc.encode(s);
      parts.push(varint(b.length), b);
    }
  parts.push(Uint8Array.of(0));
  return concat(...parts);
}
const u64 = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (b: Uint8Array) => {
  let n = 0n;
  for (const x of b) n = n * 256n + BigInt(x);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
};

export type Ed25519Signer = {
  publicKey: Uint8Array; // 32 bytes
  sign: (message: Uint8Array) => Promise<Uint8Array>; // 64-byte signature
};

export async function ephemeralSigner(): Promise<Ed25519Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    publicKey,
    sign: async (m) =>
      new Uint8Array(
        await crypto.subtle.sign("Ed25519", pair.privateKey, m as BufferSource),
      ),
  };
}

// Returns the serialized data item and its id. Irys names items by the sha256 of
// the signature, encoded in base58 (Arweave gateways use base64url of the same bytes).
export async function createDataItem(
  data: Uint8Array,
  tags: { name: string; value: string }[],
  signer: Ed25519Signer,
) {
  const rawTags = encodeTags(tags);
  const empty = new Uint8Array();
  const message = await deepHash([
    enc.encode("dataitem"),
    enc.encode("1"),
    enc.encode(String(SIG_TYPE_ED25519)),
    signer.publicKey,
    empty, // target
    empty, // anchor
    rawTags,
    data,
  ]);
  const signature = await signer.sign(message);
  const sigType = new Uint8Array(2);
  new DataView(sigType.buffer).setUint16(0, SIG_TYPE_ED25519, true);
  const item = concat(
    sigType,
    signature,
    signer.publicKey,
    Uint8Array.of(0), // no target
    Uint8Array.of(0), // no anchor
    u64(tags.length),
    u64(rawTags.length),
    rawTags,
    data,
  );
  return { item, id: base58(await sha("SHA-256", signature)) };
}

export async function uploadToIrys(data: Uint8Array, contentType: string) {
  const { item, id } = await createDataItem(
    data,
    [{ name: "Content-Type", value: contentType }],
    await ephemeralSigner(),
  );
  const r = await fetch(`${IRYS_DEVNET}/tx/solana`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: item,
  });
  if (!r.ok)
    throw Error(`Profile storage refused the upload (${r.status}). Try a smaller image.`);
  const body = (await r.json().catch(() => ({}))) as { id?: string };
  if (body.id && body.id !== id) throw Error("Profile storage returned an unexpected id.");
  return `${IRYS_DEVNET}/${id}`;
}
