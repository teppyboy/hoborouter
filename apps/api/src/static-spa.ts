import { existsSync, realpathSync, statSync } from "node:fs";
import { Elysia } from "elysia";

/**
 * Native static SPA serving (user-approved deviation from the plan's
 * @elysiajs/static, which is hard-incompatible with elysia@2.0.0-exp.64).
 * Security invariant: the realpath of any served file must be contained in
 * the resolved dist root; dotfiles and `..` segments are always rejected
 * with 404 (never SPA fallback).
 */

const isDotOrDotDot = (s: string) => s === ".." || s === ".";

const hasUnsafeSegment = (rel: string) =>
  rel.split("/").some((s) => {
    if (s.startsWith(".") || isDotOrDotDot(s)) return true;
    try {
      const decoded = decodeURIComponent(s);
      return isDotOrDotDot(decoded) || decoded.includes("/");
    } catch {
      return true; // malformed encoding — reject
    }
  });

/**
 * Resolve a dist-relative request path to a safe absolute file path.
 * Returns null when the path is rejected (dotfiles, `..`, symlink escape,
 * directories) or missing. The realpath containment check is the trust
 * boundary — do not remove it.
 */
export const resolveStaticPath = (root: string, rel: string): string | null => {
  if (rel === "" || hasUnsafeSegment(rel)) return null;
  const p = `${root}/${rel}`;
  if (!existsSync(p)) return null;
  const real = realpathSync(p);
  if (real !== root && !real.startsWith(`${root}/`)) return null;
  return statSync(real).isFile() ? real : null;
};

export const staticSpa = (root: string) => {
  const ROOT = realpathSync(root);
  const notFound = () => new Response(null, { status: 404 });

  // Reserved API prefixes: never SPA-fallback (segment-aware, so /apiary and
  // /v12 are still SPA routes).
  const isReserved = (rel: string) => {
    const seg = rel.split("/", 1)[0];
    return seg === "api" || seg === "v1" || seg === "webhooks";
  };
  const apiNotFound = () =>
    new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });

  return new Elysia({ name: "static-spa" })
    .get("/assets/*", ({ params }) => {
      const p = resolveStaticPath(ROOT, `assets/${params["*"] ?? ""}`);
      return p ? new Response(Bun.file(p)) : notFound();
    })
    .get("/", () => {
      const p = resolveStaticPath(ROOT, "index.html");
      return p ? new Response(Bun.file(p)) : notFound();
    })
    .get("/*", ({ params }) => {
      const rel = params["*"] ?? "";
      // Percent-encoded first segments are rejected outright: Elysia decodes
      // once, so double-encoded reserved prefixes (/%2576%2531/...) and
      // single-encoded forms (/%76%31/...) would otherwise slip past the
      // reserved guard into SPA fallback. ponytail: encoded legitimate
      // first-segment SPA routes 404 by design; relax only with a
      // validated decode that can never yield a reserved segment.
      // Elysia decodes once, so /%2fapi/missing arrives with rel="/api/..."
      // (leading empty segment bypasses the reserved guard) and /%5capi as
      // a decoded backslash. Reject rel that begins with / or \\, decoded
      // dot segments, and any percent left in the first segment.
      const first = rel.split("/")[0] ?? "";
      if (
        rel.startsWith("/") ||
        rel.startsWith("\\") ||
        first.includes("%") ||
        first === "." ||
        first === ".."
      )
        return notFound();
      if (isReserved(rel)) return apiNotFound();
      if (hasUnsafeSegment(rel)) return notFound();
      const p = resolveStaticPath(ROOT, rel);
      if (p) return new Response(Bun.file(p));
      // Anything that exists under the root but was rejected (symlink
      // escape, dotfile, directory) → 404. Only truly unknown paths get
      // the SPA fallback.
      if (existsSync(`${ROOT}/${rel}`)) return notFound();
      const index = resolveStaticPath(ROOT, "index.html");
      return index ? new Response(Bun.file(index)) : notFound();
    });
};
