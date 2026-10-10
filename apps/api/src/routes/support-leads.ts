// Public support-lead intake (BMC: paid chatbot-integration support fee).
// POST /api/v1/support/integration — unauthenticated. Trust boundaries:
// - Whole body validated before any write; plain text only, never rendered as
//   HTML anywhere (the admin UI renders it as escaped React text).
// - workspace_id is honored ONLY for an authorized session that is a member of
//   that workspace; an anonymous client value is never trusted.
// - Turnstile enforced iff TURNSTILE_SECRET_KEY is set (same env the auth
//   captcha plugin uses); the secret never leaves the server or the response.
//   siteverify has an 8s AbortSignal timeout and fails closed.
// - Body is bounded BEFORE parsing (16 KiB cap, like chats.ts/v1-gateway.ts):
//   declared content-length is only a fast path, the raw stream is capped too,
//   so neither content-length spoofing nor unbounded buffering can occur.
//   The route uses parse:"none" — Elysia never buffers the body for us.
// - In-process rate cap: 3 per 10 min per client address with a hard
//   capacity (MAX_BUCKETS): at capacity, expired windows are pruned; if every
//   slot is still active, NEW addresses are denied (429 + retry-after) rather
//   than evicting an active entry — eviction would hand that address a fresh
//   quota inside the same window. Existing keys keep the original 3/window.
//   No outbound email, no money movement, no fabricated success promises in
//   the response.
import { Elysia } from "elysia";
import { type Db } from "@hoborouter/db";
import { supportLeads } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { getSession, jsonError, wsRole } from "../authz";
import { hasControlChars, validateEmail } from "./support-settings";

// --- in-process rate limit: fixed 10-min window per client address ---
const WINDOW_MS = 10 * 60_000;
const LIMIT = 3;
// Hard capacity in ACTIVE-window entries: bounds memory even if an attacker
// sprays 10k+ distinct addresses within one window. Never evict an active
// entry (that would reset the evicted address's quota); prune expired windows
// first and deny new keys only when every slot is genuinely active.
const MAX_BUCKETS = 10_000;
// Per-instance ceiling only (in-memory Map, like subscription rate-limit.ts);
// move to a shared counter table when a second API instance exists.
type Bucket = { windowStart: number; count: number };
const buckets = new Map<string, Bucket>();

// Test seam: rollover exercised without sleeping 10 minutes.
let clock: () => number = Date.now;
export const setLeadRateClock = (fn: () => number) => {
  clock = fn;
};
export const resetLeadRateLimits = () => buckets.clear();

export function checkLeadRateLimit(key: string): { ok: boolean; retryAfterSec: number } {
  const now = clock();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const b = buckets.get(key);
  if (!b || b.windowStart !== windowStart) {
    // New-key path only — an active existing entry is never disturbed, so
    // capacity handling can never reset an in-window quota.
    if (buckets.size >= MAX_BUCKETS) {
      for (const [k, e] of buckets) if (e.windowStart !== windowStart) buckets.delete(k);
    }
    if (buckets.size >= MAX_BUCKETS) {
      // Every slot is an active window entry: deny the new address until the
      // window rolls over (same retry-after boundary as per-key limiting).
      return {
        ok: false,
        retryAfterSec: Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000)),
      };
    }
    buckets.set(key, { windowStart, count: 1 });
    return { ok: true, retryAfterSec: 0 };
  }
  if (b.count >= LIMIT) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000)),
    };
  }
  b.count += 1;
  return { ok: true, retryAfterSec: 0 };
}

/**
 * Client address for rate limiting. X-Forwarded-For is honored ONLY when
 * HBR_TRUST_PROXY=true (deployed behind a trusted reverse proxy that APPENDS
 * the real client address, so the LAST entry is the only unspoofable one).
 * Without a trusted proxy, XFF is fully client-controlled and ignored — the
 * socket address is used instead.
 */
export function clientAddress(
  request: Request,
  server: { requestIP: (r: Request) => { address: string } | null } | null,
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.HBR_TRUST_PROXY === "true") {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) {
      const parts = xff
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1]!;
    }
  }
  return server?.requestIP(request)?.address ?? "unknown";
}

// Cloudflare siteverify — same endpoint/secret the Better Auth captcha plugin
// verifies against. Network failure / timeout fails closed.
async function verifyTurnstile(
  token: string,
  ip: string | null,
  doFetch: typeof fetch,
  secret: string,
): Promise<boolean> {
  try {
    const res = await doFetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      signal: AbortSignal.timeout(8_000),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret,
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      }),
    });
    if (!res.ok) return false;
    return ((await res.json()) as { success: boolean }).success === true;
  } catch {
    return false;
  }
}

// Plain-text field: trimmed, bounded, no control characters (message keeps
// newlines/tabs). Stored text is rendered as React text only — never HTML.
function boundedText(raw: unknown, max: number, multiline = false): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > max) return null;
  const ok = multiline
    ? !hasControlChars(v, true) // tab/LF/CR stay legal in message bodies
    : !hasControlChars(v);
  return ok ? v : null;
}

const tooLarge = jsonError(413, "PAYLOAD_TOO_LARGE", "Request body too large");
const MAX_BODY_BYTES = 16 * 1024;

/** Read the raw JSON body with a hard byte cap, canceling the stream on
 *  overflow (same pattern as chats.ts / v1-gateway.ts). Content-length alone
 *  is never trusted. Missing body is a 400, not a silent empty object. */
async function readBoundedBody(
  request: Request,
): Promise<{ body?: Record<string, unknown>; error?: Response }> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_BODY_BYTES)
    return { error: tooLarge };
  const reader = request.body?.getReader();
  if (!reader) return { error: jsonError(400, "INVALID", "Body must be a JSON object") };
  let total = 0;
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return { error: tooLarge };
    }
    chunks.push(value);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(Buffer.concat(chunks))) as unknown;
  } catch {
    return { error: jsonError(400, "INVALID", "Body must be a JSON object") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: jsonError(400, "INVALID", "Body must be a JSON object") };
  }
  return { body: parsed as Record<string, unknown> };
}

export const supportLeadRoutes = (
  db: Db,
  auth: BetterAuthInstance,
  // Test seam: injected siteverify transport so tests never hit the network.
  // `env` carries the resolved startup record when provided.
  opts: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {},
) =>
  new Elysia({ name: "support-leads" }).post(
    "/api/v1/support/integration",
    {
      // parse:"none": Elysia must not buffer/parse the body itself — the
      // handler reads the raw stream under the 16 KiB cap below.
      parse: "none",
      detail: {
        tags: ["System"],
        summary: "Submit a support/integration request",
        description:
          "Unauthenticated lead intake for paid chatbot-integration support. Turnstile-protected when the server has TURNSTILE_SECRET_KEY; rate limited; no account, payment, or email side effects.",
      },
    },
    async ({ request, server, set }) => {
      // Rate limit before anything else (cheapest rejection first; an
      // over-limit client's body is never read at all).
      const rl = checkLeadRateLimit(clientAddress(request, server, opts.env));
      if (!rl.ok) {
        return new Response(
          JSON.stringify({
            error: { code: "RATE_LIMITED", message: "Too many support requests, try again later" },
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": String(rl.retryAfterSec),
            },
          },
        );
      }

      // Turnstile: enforced iff the server-side secret is configured (from
      // the injected env record when present; process.env otherwise).
      const turnstileSecret = opts.env?.TURNSTILE_SECRET_KEY ?? process.env.TURNSTILE_SECRET_KEY;
      if (turnstileSecret) {
        const token = request.headers.get("x-captcha-response");
        if (!token) return jsonError(400, "CAPTCHA_REQUIRED", "Captcha token required");
        const ok = await verifyTurnstile(
          token,
          server?.requestIP(request)?.address ?? null,
          opts.fetch ?? fetch,
          turnstileSecret,
        );
        if (!ok) return jsonError(403, "CAPTCHA_FAILED", "Captcha verification failed");
      }

      // Body bound: declared length is only a fast path; the raw stream is
      // read with a hard 16 KiB cap and canceled on overflow.
      const bounded = await readBoundedBody(request);
      if (bounded.error || !bounded.body) {
        return bounded.error ?? jsonError(400, "INVALID", "Body must be a JSON object");
      }
      const b = bounded.body;

      const email = validateEmail(String(b.contact_email ?? ""));
      if (!email) {
        return jsonError(400, "INVALID", "contact_email must be a valid email address");
      }
      const channel =
        b.contact_channel === undefined || b.contact_channel === null
          ? null
          : boundedText(b.contact_channel, 200);
      if (channel === null && b.contact_channel !== undefined && b.contact_channel !== null) {
        return jsonError(
          400,
          "INVALID",
          "contact_channel must be text without control characters (max 200 chars)",
        );
      }
      const message = boundedText(b.message, 5000, true);
      if (!message || message.length < 10) {
        return jsonError(
          400,
          "INVALID",
          "message must be 10-5000 characters without control characters",
        );
      }

      // Workspace attach: only for an authorized session member of the
      // requested workspace; anonymous or non-member values are dropped.
      let workspaceId: string | null = null;
      const requested =
        typeof b.workspace_id === "string" && b.workspace_id ? b.workspace_id : null;
      if (requested) {
        const session = await getSession(auth, request);
        if (session && (await wsRole(db, requested, session.user.id))) workspaceId = requested;
      }

      const id = crypto.randomUUID();
      await db.insert(supportLeads).values({
        id,
        contact_email: email,
        contact_channel: channel,
        workspace_id: workspaceId,
        message,
        status: "open",
        created_at: Date.now(),
      });
      // 201: the lead was created; response body is only {id,status}.
      set.status = 201;
      return { id, status: "open" } as const satisfies { id: string; status: "open" };
    },
  );
