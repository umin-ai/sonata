import { isProfileUrl, parseProfile } from "@/lib/token-profile";
import { clientKey, createRateLimit } from "@/lib/server/rate-limit";

// Serves a token's profile from its metadata URI through Sonata's own origin,
// so the page does not depend on a cross-site fetch that browsers or content
// blockers may refuse. Only Sonata's CloudFront and Irys URIs are fetched
// (isProfileUrl), the JSON is size-capped, and only fields that pass
// parseProfile are returned. Files are content-addressed, so they cache long.
export const dynamic = "force-dynamic";
const allow = createRateLimit({ perKey: 300, total: 5_000, windowMs: 60_000 });
const MAX_BYTES = 20_000;

export async function GET(request: Request) {
  const noStore = { "Cache-Control": "no-store" };
  if (!allow(clientKey(request)))
    return Response.json({ error: "Too many requests." }, { status: 429, headers: noStore });
  const uri = new URL(request.url).searchParams.get("uri") ?? "";
  if (!isProfileUrl(uri)) return Response.json({ error: "Unsupported profile location." }, { status: 400, headers: noStore });
  try {
    // CloudFront's managed firewall rejects requests without a User-Agent, and
    // the Workers runtime sends none by default.
    const r = await fetch(uri, {
      headers: { accept: "application/json", "user-agent": "SonataTokenMeta/1.0 (+https://sonata.umin.ai)" },
      redirect: "manual",
    });
    if (!r.ok) {
      return Response.json({ error: "Profile unavailable." }, { status: 502, headers: noStore });
    }
    const text = await r.text();
    if (text.length > MAX_BYTES) return Response.json({ error: "Profile too large." }, { status: 502, headers: noStore });
    // Validated fields only, in the metadata shape parseProfile reads.
    const p = parseProfile(JSON.parse(text));
    const body = {
      ...(p.description ? { description: p.description } : {}),
      ...(p.image ? { image: p.image } : {}),
      ...(p.links.website ? { website: p.links.website } : {}),
      ...(p.links.x ? { twitter: p.links.x } : {}),
      ...(p.links.telegram ? { telegram: p.links.telegram } : {}),
    };
    return Response.json(body, {
      headers: { "Cache-Control": "public, max-age=86400" },
    });
  } catch {
    return Response.json({ error: "Profile unavailable." }, { status: 502, headers: noStore });
  }
}
