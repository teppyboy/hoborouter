// Cloudflare Turnstile wiring for auth forms. The site key is NOT a build-time
// constant: it comes from GET /api/v1/public-config so a published image can
// enable captcha purely via TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY env.
// When the config says captcha is off (siteKey null) the widget renders
// nothing and the form works normally.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id: string) => void;
    };
  }
}

export interface PublicConfig {
  turnstileSiteKey: string | null;
  emailVerification: { enabled: boolean; required: boolean };
}

/**
 * Same-origin public config, cached by the shared queryClient. Exported for
 * the upcoming email-verification UI; auth forms consume turnstileSiteKey.
 */
export function usePublicConfig() {
  return useQuery<PublicConfig>({
    queryKey: ["public-config"],
    queryFn: async () => {
      const res = await fetch("/api/v1/public-config");
      if (!res.ok) throw new Error(`public config ${res.status}`);
      return (await res.json()) as PublicConfig;
    },
    staleTime: 60_000,
  });
}

let scriptPromise: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      // Drop the failed tag and cached promise so an explicit retry can
      // reload the script instead of rejecting forever.
      s.remove();
      scriptPromise = null;
      reject(new Error("turnstile script failed"));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Renders a fresh widget whenever the widget identity changes (siteKey,
 * theme, or a parent-driven resetKey after a failed auth attempt). Every
 * re-render invalidates the previous token: Turnstile tokens are one-shot.
 */
export function Turnstile({
  siteKey,
  onToken,
  resetKey = 0,
  onScriptError,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  resetKey?: number;
  onScriptError?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  // Ref keeps the render callback stable so parent keystrokes never re-render
  // the widget (which would reset a solved challenge).
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const onScriptErrorRef = useRef(onScriptError);
  onScriptErrorRef.current = onScriptError;
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    typeof document === "undefined" || document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
  );

  useEffect(() => {
    const obs = new MutationObserver(() =>
      setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light"),
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    // New widget instance: any token from the previous one is stale.
    onTokenRef.current(null);
    let cancelled = false;
    loadTurnstile()
      .then(() => {
        if (cancelled || !ref.current || !window.turnstile || widgetId.current) return;
        widgetId.current = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          theme,
          callback: (token: string) => onTokenRef.current(token),
          "error-callback": () => {
            onTokenRef.current(null);
            window.turnstile?.reset(widgetId.current ?? undefined);
            return true;
          },
          "expired-callback": () => {
            onTokenRef.current(null);
            window.turnstile?.reset(widgetId.current ?? undefined);
          },
        });
      })
      .catch(() => {
        onTokenRef.current(null);
        onScriptErrorRef.current?.();
      });
    return () => {
      cancelled = true;
      if (widgetId.current) {
        window.turnstile?.remove(widgetId.current);
        widgetId.current = null;
      }
    };
  }, [siteKey, theme, resetKey]);

  return <div ref={ref} className="min-h-16" />;
}
