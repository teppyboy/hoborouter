// Renders ONLY the support links the instance admin actually configured,
// after protocol/host validation. Never invents accounts: a missing or
// invalid value renders nothing. Consumed by the public layout footer and
// auth pages later.
import type { PublicSupportLinks } from "../lib/public-queries";

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

/** Validate + normalize one configured support channel; null when unusable. */
export function normalizeSupportLink(
  kind: keyof Omit<PublicSupportLinks, "email"> | "email",
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

/** All configured links in a stable order; empty when nothing is set. */
export function supportLinks(support: PublicSupportLinks | null | undefined): SupportLink[] {
  if (!support) return [];
  return [
    normalizeSupportLink("email", support.email),
    normalizeSupportLink("telegram", support.telegram),
    normalizeSupportLink("facebook", support.facebook),
    normalizeSupportLink("threads", support.threads),
  ].filter((l): l is SupportLink => l !== null);
}

export function SupportLinks({ support }: { support: PublicSupportLinks | null | undefined }) {
  const links = supportLinks(support);
  if (links.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      {links.map((l) => (
        <a
          key={l.label}
          href={l.href}
          target={l.href.startsWith("mailto:") ? undefined : "_blank"}
          rel="noreferrer noopener"
          className="text-muted-foreground hover:text-foreground"
        >
          {l.label}
        </a>
      ))}
    </div>
  );
}
