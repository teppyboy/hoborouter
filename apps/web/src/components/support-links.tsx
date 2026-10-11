// Renders ONLY the support links the instance admin actually configured,
// after protocol/host validation. Never invents accounts: a missing or
// invalid value renders nothing. Consumed by the public layout footer and
// auth pages later.
import type { PublicSupportLinks } from "../lib/public-queries";

/** Project contact used only when the instance has no usable email configured
 * (missing/empty/unusable). A valid DB-configured support email always wins. */
export const DEFAULT_SUPPORT_EMAIL = "contact@hoborouter.tretrauit.me";

export interface SupportLink {
  label: string;
  href: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEGRAM_HANDLE_RE = /^[A-Za-z0-9_]{4,64}$/;

function isHttpsUrl(value: string, host: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:") return null;
    const h = u.hostname.toLowerCase();
    if (h === host || h.endsWith(`.${host}`)) return u.toString();
    return null;
  } catch {
    return null;
  }
}

/** Validate + normalize one configured support channel; null when unusable.
 * Custom links are handled separately (normalizeCustomLink). */
export function normalizeSupportLink(
  kind: "email" | "telegram" | "facebook" | "threads",
  raw: string | null | undefined,
): SupportLink | null {
  const value = raw?.trim();
  if (!value) return null;
  switch (kind) {
    case "email":
      return EMAIL_RE.test(value) ? { label: "Email", href: `mailto:${value}` } : null;
    case "telegram": {
      // Accept a bare handle (@name or name) or a https://t.me/... URL.
      const handle = value.replace(/^@/, "");
      if (TELEGRAM_HANDLE_RE.test(handle))
        return { label: "Telegram", href: `https://t.me/${handle}` };
      const url = isHttpsUrl(value, "t.me");
      return url ? { label: "Telegram", href: url } : null;
    }
    case "facebook": {
      const url = isHttpsUrl(value, "facebook.com");
      return url ? { label: "Facebook", href: url } : null;
    }
    case "threads": {
      const url = isHttpsUrl(value, "threads.net");
      return url ? { label: "Threads", href: url } : null;
    }
  }
}

/** Validate + normalize one admin-curated custom link; null when unusable.
 * The server re-validates on read, but the client stays defensive because
 * these labels/URLs are rendered on public pages. */
function normalizeCustomLink(raw: unknown): SupportLink | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { label, url } = raw as { label?: unknown; url?: unknown };
  if (typeof label !== "string" || typeof url !== "string") return null;
  const l = label.trim();
  if (!l || l.length > 30 || hasControlChars(l)) return null;
  const value = url.trim();
  if (!value || hasControlChars(value) || value.includes("\\") || value.startsWith("//"))
    return null;
  let href: string;
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      !u.hostname ||
      !u.hostname.includes(".")
    )
      return null;
    href = u.toString();
  } catch {
    return null;
  }
  return { label: l, href };
}

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/** All configured links in a stable order; email falls back to the project
 * contact when the instance has none — including while the instance query is
 * loading/errored (support stays reachable instead of rendering empty). */
export function supportLinks(support: PublicSupportLinks | null | undefined): SupportLink[] {
  const configured = support
    ? [
        normalizeSupportLink("email", support.email),
        normalizeSupportLink("telegram", support.telegram),
        normalizeSupportLink("facebook", support.facebook),
        normalizeSupportLink("threads", support.threads),
        ...(support.custom ?? []).map(normalizeCustomLink),
      ].filter((l): l is SupportLink => l !== null)
    : [];
  if (configured.some((l) => l.label === "Email")) return configured;
  // Unusable/absent configured email: keep support reachable. Empty (trim) is
  // treated as missing; a valid configured email can never be overridden here.
  const fallback = normalizeSupportLink("email", DEFAULT_SUPPORT_EMAIL);
  return fallback ? [fallback, ...configured] : configured;
}

export function SupportLinks({
  support,
  showValues = false,
}: {
  support: PublicSupportLinks | null | undefined;
  /** Show the validated value itself (bare email address / normalized URL),
   * selectable for copy, instead of the compact channel label. */
  showValues?: boolean;
}) {
  const links = supportLinks(support);
  if (links.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      {links.map((l, i) => {
        // Email shows the bare address (no mailto: scheme); other channels
        // show their normalized https URL — always the validated value.
        const value = l.href.startsWith("mailto:") ? l.href.slice("mailto:".length) : l.href;
        if (showValues)
          return (
            <a
              key={`${i}-${l.label}`}
              href={l.href}
              target={l.href.startsWith("mailto:") ? undefined : "_blank"}
              rel="noreferrer noopener"
              className="break-all text-muted-foreground hover:text-foreground"
            >
              <span className="font-mono text-foreground select-all">{value}</span>
            </a>
          );
        return (
          <a
            key={`${i}-${l.label}`}
            href={l.href}
            target={l.href.startsWith("mailto:") ? undefined : "_blank"}
            rel="noreferrer noopener"
            className="text-muted-foreground hover:text-foreground"
          >
            {l.label}
          </a>
        );
      })}
    </div>
  );
}
