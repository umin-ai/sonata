"use client";
import { TokenFallback } from "@/app/token-identity";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSnapshotProfile } from "@/app/onchain/snapshot-context";
import { Globe, Send } from "lucide-react";
import {
  isProfileUrl,
  label,
  parseProfile,
  type SocialKind,
  type TokenProfile,
} from "@/lib/token-profile";

// Reads a token's profile through Sonata's own /api/token-meta, which fetches
// only Sonata's CloudFront and Irys URIs and validates the result. The profile
// is validated again here, so a link is never shown unless it passes.
const cache = new Map<string, Promise<TokenProfile | null>>();
export function loadProfile(uri: string) {
  if (!cache.has(uri))
    cache.set(
      uri,
      fetch(`/api/token-meta?v=2&uri=${encodeURIComponent(uri)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => (json ? parseProfile(json) : null))
        .catch(() => null),
    );
  return cache.get(uri)!;
}

export function useTokenProfile(uri?: string) {
  // The server's market snapshot may already carry it (the /api/token-meta body),
  // validated here the same way, so the first render needs no fetch; null there
  // means the server could not read it lately (or, for a market the live stream
  // just added, not yet), so it is not asked again. A body that arrives later
  // (the live stream's) is shown when it comes.
  const seeded = useSnapshotProfile(uri);
  const seededProfile = useMemo(() => (uri && seeded && isProfileUrl(uri) ? parseProfile(seeded) : null), [uri, seeded]);
  // Keyed by URI so a stale profile is never shown for a different token.
  const [loaded, setLoaded] = useState<{ uri: string; profile: TokenProfile | null } | null>(() =>
    uri && seeded !== undefined && isProfileUrl(uri) ? { uri, profile: seeded ? parseProfile(seeded) : null } : null,
  );
  const known = !!uri && loaded?.uri === uri;
  useEffect(() => {
    if (!uri || !isProfileUrl(uri) || known) return;
    let active = true;
    void loadProfile(uri).then((profile) => {
      if (active) setLoaded({ uri, profile });
    });
    return () => {
      active = false;
    };
  }, [uri, known]);
  return seededProfile ?? (loaded && loaded.uri === uri ? loaded.profile : null);
}

function XMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
    </svg>
  );
}

const ICONS: Record<SocialKind, (p: { size?: number }) => React.ReactNode> = {
  website: ({ size }) => <Globe size={size} />,
  x: XMark,
  telegram: ({ size }) => <Send size={size} />,
};

export function TokenLinks({ profile }: { profile: TokenProfile | null }) {
  const entries = Object.entries(profile?.links ?? {}) as [SocialKind, string][];
  if (!entries.length) return null;
  return (
    <div className="token-links">
      {entries.map(([kind, href]) => {
        const Icon = ICONS[kind];
        return (
          <a
            key={kind}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            aria-label={label(kind)}
            title={href}
          >
            <Icon size={14} /> <span>{label(kind)}</span>
          </a>
        );
      })}
    </div>
  );
}

/**
 * A token's image, or the "?" badge when it has none or the image fails to
 * load. `fallback={false}` draws nothing instead, for a frame that has its own.
 */
export function TokenImage({
  profile,
  symbol,
  size = 40,
  fallback = true,
}: {
  profile: TokenProfile | null;
  symbol: string;
  size?: number;
  fallback?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  // ROOM, the flagship demo market, has no token profile; it uses its own logo (as in token-identity.tsx).
  const src = profile?.image ?? (symbol === "ROOM" ? "/token-logos/ROOM.svg" : undefined);
  const ref = useRef<HTMLImageElement>(null);
  // An image in the server's HTML can fail before React is listening for its
  // error: show the fallback then too.
  useEffect(() => {
    const img = ref.current;
    if (src && img?.complete && img.naturalWidth === 0) setFailed(src);
  }, [src]);
  if (!src || failed === src) return fallback ? <TokenFallback size={size} /> : null;
  return (
    <img
      ref={ref}
      className="token-image"
      src={src}
      alt={`${symbol} logo`}
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(src)}
    />
  );
}
