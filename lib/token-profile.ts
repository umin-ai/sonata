// Token profile: description, image and social links stored in the token's
// public metadata JSON (the Metaplex `uri`), like pump.fun's create form. The
// same validators run before upload and again when a profile is displayed, so a
// link read back from chain is never rendered unless it passes.

// Where profiles may live: Sonata's S3 bucket behind CloudFront (content-addressed
// keys), or Irys devnet (used when S3 is not configured).
export const CDN_HOST = "d3lwm4c3ge2mv2.cloudfront.net";
export const PROFILE_HOSTS = [CDN_HOST, "devnet.irys.xyz", "gateway.irys.xyz"] as const;
export const MAX_IMAGE_BYTES = 95_000; // under Irys's free upload size
export const MAX_DESCRIPTION = 280;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// Where a token's creator share of the fee goes, fixed at launch. Written into the
// metadata JSON as `sonata.feeModel`; Sonata's payout bot reads it for markets it
// pays out ("holders" and the three modules).
export const FEE_MODELS = ["standard", "backed", "holders", "buyback", "topBuyers", "lpFarm", "split", "diamond"] as const;
export type FeeModel = (typeof FEE_MODELS)[number];
export const isFeeModel = (v: unknown): v is FeeModel =>
  typeof v === "string" && (FEE_MODELS as readonly string[]).includes(v);
import { validateSplit } from "./split-rules.mjs";
// Split: up to 5 wallets, each with a whole-number weight from 1 to 100.
export type SplitRecipient = { wallet: string; weight: number };
export const MAX_SPLIT = 5;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function normalizeSplit(input: unknown): SplitRecipient[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_SPLIT)
    throw Error(`Split: add 1 to ${MAX_SPLIT} wallets.`);
  const seen = new Set<string>();
  const split = input.map((r) => {
    const wallet = typeof r?.wallet === "string" ? r.wallet.trim() : "";
    const weight = Number(r?.weight);
    if (!BASE58.test(wallet)) throw Error("Split: one of the wallets is not a Solana address.");
    if (seen.has(wallet)) throw Error("Split: each wallet can appear once.");
    if (!Number.isInteger(weight) || weight < 1 || weight > 100)
      throw Error("Split: use a whole number from 1 to 100 for each share.");
    seen.add(wallet);
    return { wallet, weight };
  });
  // Then the payout bot's own rules (lib/split-rules.mjs), so a split accepted here
  // is one the bot will pay: normal wallets only, never Sonata's or a program.
  const bot = validateSplit(split) as { ok: boolean; reason?: string };
  if (!bot.ok) {
    const reason = bot.reason ?? "";
    throw Error(
      /Sonata or program/.test(reason)
        ? "Split: Sonata's own wallets and program addresses can't be recipients."
        : /off curve/.test(reason)
          ? "Split: use normal wallet addresses only."
          : `Split: ${reason}.`,
    );
  }
  return split;
}

export type SocialKind = "website" | "x" | "telegram";
export type TokenLinks = Partial<Record<SocialKind, string>>;
export type TokenProfile = {
  description?: string;
  image?: string;
  links: TokenLinks;
  feeModel?: FeeModel;
  split?: SplitRecipient[];
};

const SOCIAL_HOSTS: Record<Exclude<SocialKind, "website">, string[]> = {
  x: ["x.com", "twitter.com"],
  telegram: ["t.me", "telegram.me"],
};

// Returns a normalised https URL, or throws with a message for the creator.
export function normalizeLink(kind: SocialKind, input: string): string {
  const value = input.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error(`${label(kind)}: enter a full link starting with https://`);
  }
  if (url.protocol !== "https:")
    throw Error(`${label(kind)}: only https:// links are allowed.`);
  if (url.username || url.password)
    throw Error(`${label(kind)}: links cannot contain a username or password.`);
  if (value.length > 200) throw Error(`${label(kind)}: link is too long.`);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (kind !== "website" && !SOCIAL_HOSTS[kind].includes(host))
    throw Error(
      `${label(kind)}: use a ${SOCIAL_HOSTS[kind].join(" or ")} link.`,
    );
  if (kind !== "website" && url.pathname.replace(/\/+$/, "") === "")
    throw Error(`${label(kind)}: link to the account or group, not the home page.`);
  return url.toString();
}

export function label(kind: SocialKind) {
  return kind === "x" ? "X" : kind === "telegram" ? "Telegram" : "Website";
}

// Validates optional links, dropping empty ones.
export function normalizeLinks(input: Partial<Record<SocialKind, string>>) {
  const links: TokenLinks = {};
  for (const kind of ["website", "x", "telegram"] as const) {
    const v = input[kind]?.trim();
    if (v) links[kind] = normalizeLink(kind, v);
  }
  return links;
}

export function normalizeDescription(input: string | undefined) {
  const text = (input ?? "").replace(/\s+/g, " ").trim();
  if (text.length > MAX_DESCRIPTION)
    throw Error(`Description: keep it under ${MAX_DESCRIPTION} characters.`);
  return text;
}

export function isProfileUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.search || url.hash) return false;
    if (url.hostname === CDN_HOST)
      return /^\/tokens\/[0-9a-f]{64}\.(json|webp|png|jpg|gif)$/.test(url.pathname);
    return (
      (PROFILE_HOSTS as readonly string[]).includes(url.hostname) &&
      /^\/[A-Za-z0-9_-]{43,44}$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

// Metaplex fungible metadata, plus the social fields explorers and launchpads read:
// `extensions` (token-list style) and top-level website/twitter/telegram (pump.fun style).
export function buildMetadata(input: {
  name: string;
  symbol: string;
  description: string;
  image?: string;
  imageType?: string;
  links: TokenLinks;
  feeModel?: FeeModel;
  split?: SplitRecipient[];
}) {
  const { website, x, telegram } = input.links;
  const socials = {
    ...(website ? { website } : {}),
    ...(x ? { twitter: x } : {}),
    ...(telegram ? { telegram } : {}),
  };
  return {
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    ...(input.image ? { image: input.image } : {}),
    ...(website ? { external_url: website } : {}),
    ...socials,
    extensions: socials,
    ...(input.image
      ? {
          properties: {
            category: "image",
            files: [{ uri: input.image, type: input.imageType ?? "image/webp" }],
          },
        }
      : {}),
    createdOn: "https://sonata.umin.ai",
    ...(input.feeModel
      ? { sonata: { feeModel: input.feeModel, ...(input.feeModel === "split" ? { split: input.split } : {}) } }
      : {}),
  };
}

// Reads a profile back from untrusted metadata JSON. Anything that fails
// validation is dropped rather than shown.
export function parseProfile(json: unknown): TokenProfile {
  const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const ext = (o.extensions && typeof o.extensions === "object"
    ? o.extensions
    : {}) as Record<string, unknown>;
  const pick = (...values: unknown[]) =>
    values.find((v): v is string => typeof v === "string" && v.length > 0);
  const links: TokenLinks = {};
  for (const [kind, raw] of [
    ["website", pick(o.website, ext.website, o.external_url)],
    ["x", pick(o.twitter, ext.twitter)],
    ["telegram", pick(o.telegram, ext.telegram)],
  ] as const) {
    if (!raw) continue;
    try {
      links[kind] = normalizeLink(kind, raw);
    } catch {
      /* invalid links are not displayed */
    }
  }
  const image = pick(o.image);
  let description: string | undefined;
  try {
    description = normalizeDescription(pick(o.description)) || undefined;
  } catch {
    description = undefined;
  }
  const sonata = (o.sonata && typeof o.sonata === "object" ? o.sonata : {}) as Record<string, unknown>;
  const feeModel = isFeeModel(sonata.feeModel) ? sonata.feeModel : undefined;
  let split: SplitRecipient[] | undefined;
  if (feeModel === "split")
    try {
      split = normalizeSplit(sonata.split);
    } catch {
      split = undefined;
    }
  return {
    description,
    image: image && isProfileUrl(image) ? image : undefined,
    links,
    ...(feeModel ? { feeModel } : {}),
    ...(split ? { split } : {}),
  };
}

// First bytes of each allowed image type, checked server-side before upload.
export function sniffImage(bytes: Uint8Array): string | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  return null;
}
