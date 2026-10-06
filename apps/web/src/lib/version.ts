// Build-time version injection: vite.config.ts defines __APP_VERSION__ from
// this package's package.json (single source of truth — no version literal is
// ever duplicated in UI code). Undefined outside a Vite build (tests, SSR),
// so consumers must treat it as nullable.
declare const __APP_VERSION__: string | undefined;

/** The app's package version, or null when no build-time value was injected. */
export function appVersion(): string | null {
  return typeof __APP_VERSION__ === "string" && __APP_VERSION__.length > 0 ? __APP_VERSION__ : null;
}
