// Shared layout for the unauthenticated public pages: /, /pricing,
// /docs/quickstart (routes are wired in router.tsx —
// this file owns no router imports so pages stay SSR/test friendly).
// Plain <a> navigation: public pages are entry points, a full load is fine.
// Responsive by flex-wrap (375px OK); flat theme tokens, no gradient hero.
import { type ReactNode } from "react";
import { Shuffle } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import { SupportLinks } from "./support-links";
import type { PublicInstance } from "../lib/public-queries";

const NAV = [
  { label: "Welcome", href: "/" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs/quickstart" },
];

export function PublicLayout({
  children,
  instance,
}: {
  children: ReactNode;
  instance?: PublicInstance | null;
}) {
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
              <a
                key={n.label}
                href={n.href}
                className="text-muted-foreground hover:text-foreground"
              >
                {n.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <a
              href="/login"
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
            >
              Sign in
            </a>
            <a
              href="/signup"
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Sign up
            </a>
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
            Terms
          </a>
          <a href="/privacy" className="text-muted-foreground hover:text-foreground">
            Privacy
          </a>
        </div>
      </footer>
    </div>
  );
}
