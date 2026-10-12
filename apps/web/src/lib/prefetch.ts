import { lazy } from "react";

/**
 * React.lazy with a .preload() so nav chunks can be warmed on hover/focus
 * or during idle time, instead of loading on first render (skeleton flash).
 */
export function lazyRoute<T extends React.ComponentType>(loader: () => Promise<{ default: T }>) {
  const Component = lazy(loader);
  return Object.assign(Component, { preload: () => loader() });
}

// Route chunks (single source: router.tsx imports these).
export const overview = lazyRoute(() => import("../pages/overview"));
export const models = lazyRoute(() => import("../pages/models"));
export const modelDetail = lazyRoute(() => import("../pages/models/detail"));
export const keys = lazyRoute(() => import("../pages/keys"));
export const logs = lazyRoute(() => import("../pages/logs"));
export const usage = lazyRoute(() => import("../pages/usage"));
export const analytics = lazyRoute(() => import("../pages/analytics"));
export const credits = lazyRoute(() => import("../pages/billing/credits"));
export const bundles = lazyRoute(() => import("../pages/billing/bundles"));
export const payments = lazyRoute(() => import("../pages/billing/payments"));
export const settings = lazyRoute(() => import("../pages/settings"));
export const adminUsers = lazyRoute(() => import("../pages/admin/users"));
export const adminModels = lazyRoute(() => import("../pages/admin/models"));
export const adminPayments = lazyRoute(() => import("../pages/admin/payments"));
export const adminSettings = lazyRoute(() => import("../pages/admin/settings"));

/** Nav-path -> route chunk, used for hover preload and idle prefetch. */
export const chunkByPath: Record<string, { preload: () => Promise<unknown> }> = {
  "/": overview,
  "/models": models,
  "/keys": keys,
  "/logs": logs,
  "/usage": usage,
  "/analytics": analytics,
  "/billing/credits": credits,
  "/billing/bundles": bundles,
  "/billing/payments": payments,
  "/settings": settings,
};

/** Preload the chunk for a nav path (called from Link onMouseEnter/onFocus). */
export function preloadChunk(path: string) {
  chunkByPath[path]?.preload().catch(() => {});
}

let idlePrefetched = false;

/** Prefetch main nav chunks once, after first paint, when the browser is idle. */
export function preloadNavChunksOnIdle() {
  if (idlePrefetched || typeof requestIdleCallback !== "function") return;
  idlePrefetched = true;
  requestIdleCallback(() => {
    for (const entry of Object.values(chunkByPath)) entry.preload().catch(() => {});
  });
}
