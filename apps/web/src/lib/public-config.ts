// Public-config social-provider availability. The backend contract is a
// paired-env enabled-flag map (e.g. GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET on
// the server); the client never sees provider secrets or env values — only
// this boolean map, and it is OPTIONAL: a backend that predates social
// sign-in simply omits it, which reads as "no providers enabled" so the
// email flow is never affected.
import type { PublicConfig } from "../components/turnstile";

/** Exactly the Better Auth client social provider ids these pages support. */
export const SOCIAL_PROVIDER_IDS = ["google", "discord", "github"] as const;
export type SocialProviderId = (typeof SOCIAL_PROVIDER_IDS)[number];

export interface SocialProvidersConfig {
  google: boolean;
  discord: boolean;
  github: boolean;
}

export type PublicConfigWithSocial = PublicConfig & {
  socialProviders?: Partial<SocialProvidersConfig>;
};

/**
 * Enabled provider ids, in fixed display order. Anything absent or not
 * strictly true is disabled — the map is additive, never a default-on list.
 */
export function socialProvidersFrom(
  config: PublicConfigWithSocial | undefined | null,
): SocialProviderId[] {
  const map = config?.socialProviders;
  if (!map) return [];
  return SOCIAL_PROVIDER_IDS.filter((id) => map[id] === true);
}
