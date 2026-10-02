// Shared full-screen layout for /login and /signup. Router wraps pages in a
// padded <Page>, so this uses fixed inset-0 to own the whole viewport.
import { type ReactNode } from "react";
import { Shuffle } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-10 flex flex-col overflow-y-auto bg-background">
      <div className="flex items-center gap-2 p-6">
        <Shuffle className="size-5 shrink-0" aria-hidden />
        <span className="font-semibold tracking-tight">Hoborouter</span>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[360px] rounded-lg border bg-card p-6">{children}</div>
      </div>
    </div>
  );
}
