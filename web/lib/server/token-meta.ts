import { isProfileUrl, parseProfile } from "@/lib/token-profile";
import type { ProfileBody } from "@/lib/treasury/market-snapshot";

// A token's profile from its metadata URI, as app/api/token-meta serves it and
// the market snapshot carries it: only Sonata's CloudFront and Irys URIs are
// fetched (isProfileUrl), redirects are not followed, the JSON is size-capped,
// and only fields that pass parseProfile are kept. The browser runs
// parseProfile on this body again before showing anything.
export const MAX_PROFILE_BYTES = 20_000;

/** Why a profile could not be served; `status` is the route's HTTP status for it. */
export class ProfileError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function fetchProfileBody(uri: string, signal?: AbortSignal): Promise<ProfileBody> {
  if (!isProfileUrl(uri)) throw new ProfileError("Unsupported profile location.", 400);
  let text: string;
  try {
    // CloudFront's managed firewall rejects requests without a User-Agent, and
    // the Workers runtime sends none by default.
    const r = await fetch(uri, {
      headers: { accept: "application/json", "user-agent": "SonataTokenMeta/1.0 (+https://sonata.umin.ai)" },
      redirect: "manual",
      signal,
    });
    if (!r.ok) throw new ProfileError("Profile unavailable.", 502);
    text = await r.text();
  } catch (e) {
    throw e instanceof ProfileError ? e : new ProfileError("Profile unavailable.", 502);
  }
  if (text.length > MAX_PROFILE_BYTES) throw new ProfileError("Profile too large.", 502);
  let p: ReturnType<typeof parseProfile>;
  try {
    // Validated fields only, in the metadata shape parseProfile reads.
    p = parseProfile(JSON.parse(text));
  } catch {
    throw new ProfileError("Profile unavailable.", 502);
  }
  return {
    ...(p.description ? { description: p.description } : {}),
    ...(p.image ? { image: p.image } : {}),
    ...(p.links.website ? { website: p.links.website } : {}),
    ...(p.links.x ? { twitter: p.links.x } : {}),
    ...(p.links.telegram ? { telegram: p.links.telegram } : {}),
    ...(p.feeModel ? { sonata: { feeModel: p.feeModel, ...(p.split ? { split: p.split } : {}) } } : {}),
  };
}
