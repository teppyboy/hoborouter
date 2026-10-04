// Shared full-screen layout for /login and /signup. Router wraps pages in a
// padded <Page>, so this uses fixed inset-0 to own the whole viewport.
import { type ReactNode } from "react";
import { Shuffle } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    // Scroll container owns the safe-area insets once; inner blocks keep their
    // plain responsive padding so insets are never doubled.
    <div className="fixed inset-0 z-10 flex flex-col overflow-y-auto bg-background pb-safe pl-safe pr-safe pt-safe">
      <div className="flex items-center gap-2 p-4 sm:p-6">
        <Shuffle className="size-5 shrink-0" aria-hidden />
        <span className="font-semibold tracking-tight">Hoborouter</span>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
      {/* my-auto instead of items-center: overflowing content (tall signup on
          a short/landscape viewport) scrolls fully instead of clipping. */}
      <div className="flex flex-1 justify-center p-4 sm:p-6">
        <div className="my-auto w-full max-w-[360px] rounded-lg border border-border bg-card p-4 sm:p-6">
          {children}
        </div>
      </div>
    </div>
  );
}
