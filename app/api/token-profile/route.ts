import { z } from "zod";
import {
  MAX_IMAGE_BYTES,
  buildMetadata,
  normalizeDescription,
  normalizeLinks,
  sniffImage,
} from "@/lib/token-profile";
import { uploadToIrys } from "@/lib/server/irys-upload";

// Publishes a launch's token profile (image, description, social links) as the
// public metadata JSON that wallets, explorers and Jupiter read from the token's
// Metaplex `uri`. Stored on Irys devnet, Arweave's test network: uploads under
// ~100 KB are free, so each upload signs with a throwaway key and nothing is
// funded or kept (lib/server/irys-upload.ts). Devnet uploads are temporary.
export const dynamic = "force-dynamic";
const MAX_BODY = MAX_IMAGE_BYTES + 8_000;
const Fields = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 .-]{2,31}$/),
  symbol: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
  description: z.string().max(2_000).optional(),
  website: z.string().max(300).optional(),
  x: z.string().max(300).optional(),
  telegram: z.string().max(300).optional(),
});

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin)
      throw Error("Cross-origin requests are not accepted.");
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
    });
    const description = normalizeDescription(f.description);
    const links = normalizeLinks(f);
    const file = form.get("image");
    let image: string | undefined, imageType: string | undefined;
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_IMAGE_BYTES)
        throw Error("Image too large. Use one under 95 KB.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      imageType = sniffImage(bytes) ?? undefined;
      if (!imageType) throw Error("Use a PNG, JPG, WebP or GIF image.");
      image = await uploadToIrys(bytes, imageType);
    }
    if (!image && !description && !Object.keys(links).length)
      throw Error("Nothing to publish: add an image, description or link.");
    const metadata = buildMetadata({
      name: f.name,
      symbol: f.symbol,
      description,
      image,
      imageType,
      links,
    });
    const uri = await uploadToIrys(
      new TextEncoder().encode(JSON.stringify(metadata)),
      "application/json",
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
