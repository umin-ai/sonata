import { clientKey, createRateLimit } from "@/lib/server/rate-limit";
import { createProfileCache, ProfileError } from "@/lib/server/token-meta";

// Serves a token's profile from its metadata URI through Sonata's own origin,
// so the page does not depend on a cross-site fetch that browsers or content
// blockers may refuse. Only Sonata's CloudFront and Irys URIs are fetched
// (isProfileUrl), the JSON is size-capped, and only fields that pass
// parseProfile are returned (lib/server/token-meta.ts). Files are
// content-addressed, so they cache long, in browsers and in this process.
export const dynamic = "force-dynamic";
const allow = createRateLimit({ perKey: 300, total: 5_000, windowMs: 60_000 });
// Kept in memory: every open page asks for a new market's profile at once.
const profileBody = createProfileCache();

export async function GET(request: Request) {
  const noStore = { "Cache-Control": "no-store" };
  if (!allow(clientKey(request)))
    return Response.json({ error: "Too many requests." }, { status: 429, headers: noStore });
  const uri = new URL(request.url).searchParams.get("uri") ?? "";
  try {
    const body = await profileBody(uri);
    return Response.json(body, {
      headers: { "Cache-Control": "public, max-age=86400" },
    });
  } catch (e) {
    const status = e instanceof ProfileError ? e.status : 502;
    const error = e instanceof ProfileError ? e.message : "Profile unavailable.";
    return Response.json({ error }, { status, headers: noStore });
  }
}
