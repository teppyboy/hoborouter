// Build-time injection: vite.config.ts defines __APP_VERSION__/__GIT_SHA__
// via resolveBuildMetadata (build-metadata.ts — CI build args, then a dev git
// probe, with "0.0.0" never claiming a release). Undefined outside a Vite
// build (tests, SSR), so consumers must treat both as nullable.
declare const __APP_VERSION__: string | undefined;
declare const __GIT_SHA__: string | undefined;

/** The app's release version, or null when no build-time value was injected. */
export function appVersion(): string | null {
  return typeof __APP_VERSION__ === "string" && __APP_VERSION__.length > 0 ? __APP_VERSION__ : null;
}

/** Full git commit SHA injected at build time (HBR_GIT_SHA), or null. */
export function gitRevision(): string | null {
  return typeof __GIT_SHA__ === "string" && __GIT_SHA__.length > 0 ? __GIT_SHA__ : null;
}
