import { z } from "zod";
import {
  MAX_IMAGE_BYTES,
  FEE_MODELS,
  buildMetadata,
  normalizeDescription,
  normalizeLinks,
  normalizeSplit,
  sniffImage,
} from "@/lib/token-profile";
import { uploadToIrys } from "@/lib/server/irys-upload";
import { s3Config, uploadToS3 } from "@/lib/server/s3-upload";
import { clientKey, createRateLimit } from "@/lib/server/rate-limit";

// Publishes a launch's token profile (image, description, social links) as the
// public metadata JSON that wallets, explorers and Jupiter read from the token's
// Metaplex `uri`. Stored in Sonata's S3 bucket behind CloudFront, under keys that
// are the SHA-256 of each file (lib/server/s3-upload.ts). Without S3 settings it
// falls back to Irys devnet, which is free but temporary (lib/server/irys-upload.ts).
export const dynamic = "force-dynamic";
const MAX_BODY = MAX_IMAGE_BYTES + 8_000;
// Each launch publishes one profile; this leaves room for retries and blocks spam.
const allow = createRateLimit({ perKey: 6, total: 120, windowMs: 10 * 60_000 });
const Fields = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 .-]{2,31}$/),
  symbol: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
  description: z.string().max(2_000).optional(),
  website: z.string().max(300).optional(),
  x: z.string().max(300).optional(),
  telegram: z.string().max(300).optional(),
  feeModel: z.enum(FEE_MODELS).optional(),
});

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin)
      throw Error("Cross-origin requests are not accepted.");
    if (!allow(clientKey(request)))
      return Response.json(
        { error: "Too many profile uploads. Try again in a few minutes." },
        { status: 429, headers },
      );
    if (Number(request.headers.get("content-length") || 0) > MAX_BODY)
      throw Error("Image too large. Use one under 95 KB.");
    const form = await request.formData();
    const text = (key: string) => {
      const v = form.get(key);
      return typeof v === "string" && v.trim() ? v : undefined;
    };
    const f = Fields.parse({
      name: text("name"),
      symbol: text("symbol"),
      description: text("description"),
      website: text("website"),
      x: text("x"),
      telegram: text("telegram"),
      feeModel: text("feeModel"),
    });
    const description = normalizeDescription(f.description);
    // A split names its wallets in the metadata, where Sonata's payout bot reads them.
    const parse = (raw = "null") => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    };
    const split = f.feeModel === "split" ? normalizeSplit(parse(text("split"))) : undefined;
    const links = normalizeLinks(f);
    const s3 = s3Config();
    const store = (bytes: Uint8Array, type: string, ext: string) =>
      s3 ? uploadToS3(s3, bytes, type, ext) : uploadToIrys(bytes, type);
    const file = form.get("image");
    let image: string | undefined, imageType: string | undefined;
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_IMAGE_BYTES)
        throw Error("Image too large. Use one under 95 KB.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      imageType = sniffImage(bytes) ?? undefined;
      if (!imageType) throw Error("Use a PNG, JPG, WebP or GIF image.");
      const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[imageType]!;
      image = await store(bytes, imageType, ext);
    }
    const metadata = buildMetadata({
      name: f.name,
      symbol: f.symbol,
      description,
      image,
      imageType,
      links,
      feeModel: f.feeModel,
      split,
    });
    const uri = await store(
      new TextEncoder().encode(JSON.stringify(metadata)),
      "application/json",
      "json",
    );
    return Response.json({ uri, image, metadata }, { headers });
  } catch (e) {
    return Response.json(
      {
        error:
          e instanceof z.ZodError
            ? "Check the token name and ticker before adding a profile."
            : e instanceof Error
              ? e.message
              : "Profile upload failed.",
      },
      { status: 400, headers },
    );
  }
}
