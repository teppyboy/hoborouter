// Shared layout for the unauthenticated public pages: /, /pricing,
// /docs/quickstart, /about (routes are wired in router.tsx —
// this file owns no router imports so pages stay SSR/test friendly).
// Plain <a> navigation: public pages are entry points, a full load is fine.
// Responsive by flex-wrap (375px OK); flat theme tokens, no gradient hero.
import { type ReactNode } from "react";
import { Shuffle } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import { LanguageToggle } from "./language-toggle";
import { SupportLinks } from "./support-links";
import { useLocaleEntry, type LocaleEntry } from "../lib/i18n/t";
import type { PublicInstance } from "../lib/public-queries";

// Small closed chrome label set → inline LocaleEntry instead of a named
// dictionary (see lib/i18n/common.ts on key-collision churn).
const NAV: { label: LocaleEntry; href: string }[] = [
  { label: { en: "Welcome", vi: "Chào mừng" }, href: "/" },
  { label: { en: "Pricing", vi: "Bảng giá" }, href: "/pricing" },
  { label: { en: "Docs", vi: "Tài liệu" }, href: "/docs/quickstart" },
  { label: { en: "About", vi: "Giới thiệu" }, href: "/about" },
];

const signIn: LocaleEntry = { en: "Sign in", vi: "Đăng nhập" };
const signUp: LocaleEntry = { en: "Sign up", vi: "Đăng ký" };
const terms: LocaleEntry = { en: "Terms", vi: "Điều khoản" };
const privacy: LocaleEntry = { en: "Privacy", vi: "Quyền riêng tư" };

export function PublicLayout({
  children,
  instance,
}: {
  children: ReactNode;
  instance?: PublicInstance | null;
}) {
  const signInLabel = useLocaleEntry(signIn);
  const signUpLabel = useLocaleEntry(signUp);
  const termsLabel = useLocaleEntry(terms);
  const privacyLabel = useLocaleEntry(privacy);
  return (
    // Scroll container owns the safe-area insets once (same pattern as AuthLayout).
    <div className="flex min-h-screen flex-col bg-background pl-safe pr-safe">
      <header className="sticky top-0 z-10 border-b border-border bg-background pt-safe">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 p-4 sm:p-6">
          <a href="/" className="flex shrink-0 items-center gap-2">
            <Shuffle className="size-5 shrink-0" aria-hidden />
            <span className="font-semibold tracking-tight">{instance?.name ?? "Hoborouter"}</span>
          </a>
          <nav aria-label="Main" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {NAV.map((n) => (
              <PublicNavLink key={n.label.en} item={n} />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <a
              href="/login"
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
            >
              {signInLabel}
            </a>
            <a
              href="/signup"
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {signUpLabel}
            </a>
            <LanguageToggle />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 p-4 sm:p-6">{children}</main>
      {/* In-page support anchor stays for deep links (e.g. /#support). */}
      <footer
        id="support"
        className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 border-t border-border p-4 text-sm sm:p-6"
      >
        <SupportLinks support={instance?.support} />
        {/* Existing legal pages; contact info lives in the support links above. */}
        <div className="ml-auto flex items-center gap-4">
          <a href="/terms" className="text-muted-foreground hover:text-foreground">
            {termsLabel}
          </a>
          <a href="/privacy" className="text-muted-foreground hover:text-foreground">
            {privacyLabel}
          </a>
        </div>
      </footer>
    </div>
  );
}

function PublicNavLink({ item }: { item: { label: LocaleEntry; href: string } }) {
  const label = useLocaleEntry(item.label);
  return (
    <a href={item.href} className="text-muted-foreground hover:text-foreground">
      {label}
    </a>
  );
}
