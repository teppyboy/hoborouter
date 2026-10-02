// Cloudflare Turnstile widget, ready but off by default. Renders nothing and
// the form works normally when no site key is configured or on localhost.
import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id: string) => void;
    };
  }
}

const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
const isLocal = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
export const turnstileEnabled = Boolean(siteKey) && !isLocal;

let scriptPromise: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("turnstile script failed"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export function Turnstile({ onToken }: { onToken: (token: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );

  useEffect(() => {
    const obs = new MutationObserver(() =>
      setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light"),
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    loadTurnstile()
      .then(() => {
        if (cancelled || !ref.current || !window.turnstile || widgetId.current) return;
        widgetId.current = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          theme,
          callback: (token: string) => onToken(token),
          "error-callback": () => {
            onToken(null);
            window.turnstile?.reset(widgetId.current ?? undefined);
            return true;
          },
          "expired-callback": () => {
            onToken(null);
            window.turnstile?.reset(widgetId.current ?? undefined);
          },
        });
      })
      .catch(() => onToken(null));
    return () => {
      cancelled = true;
      if (widgetId.current) {
        window.turnstile?.remove(widgetId.current);
        widgetId.current = null;
      }
    };
    // theme re-render is handled by re-rendering the widget on theme change
  }, [theme, onToken]);

  if (!siteKey) return null;
  return <div ref={ref} className="min-h-16" />;
}
