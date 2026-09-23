"use client";
import { useEffect, useState } from "react";
import { Globe, Send } from "lucide-react";
import {
  isProfileUrl,
  label,
  parseProfile,
  type SocialKind,
  type TokenProfile,
} from "@/lib/token-profile";

// Reads a token's profile from its metadata URI. Only Irys URIs are fetched,
// and parseProfile drops any image or link that fails validation.
const cache = new Map<string, Promise<TokenProfile | null>>();
function loadProfile(uri: string) {
  if (!cache.has(uri))
    cache.set(
      uri,
      fetch(uri)
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => (json ? parseProfile(json) : null))
        .catch(() => null),
    );
  return cache.get(uri)!;
}

export function useTokenProfile(uri?: string) {
  // Keyed by URI so a stale profile is never shown for a different token.
  const [loaded, setLoaded] = useState<{ uri: string; profile: TokenProfile | null } | null>(null);
  useEffect(() => {
    if (!uri || !isProfileUrl(uri)) return;
    let active = true;
    void loadProfile(uri).then((profile) => {
      if (active) setLoaded({ uri, profile });
    });
    return () => {
      active = false;
    };
  }, [uri]);
  return loaded && loaded.uri === uri ? loaded.profile : null;
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

export function TokenImage({
  profile,
  symbol,
  size = 40,
}: {
  profile: TokenProfile | null;
  symbol: string;
  size?: number;
}) {
  if (!profile?.image) return null;
  return (
    <img
      className="token-image"
      src={profile.image}
      alt={`${symbol} logo`}
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
}
