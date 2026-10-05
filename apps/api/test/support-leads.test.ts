// Support-lead intake + admin management (BMC paid integration-support fee).
// Contracts under test:
// - POST /api/v1/support/integration: unauthenticated, bounded plain-text
//   validation (400), 16KB body cap (413), in-process rate cap 3/10min per
//   client address (429), Turnstile iff TURNSTILE_SECRET_KEY is set.
// - workspace_id is attached ONLY for an authorized session member; an
//   anonymous client value is never trusted.
// - GET/PATCH /api/v1/admin/support-leads: instance-admin only (401/403),
//   bounded filters + cursor pagination, audited open<->handled transition,
//   no DELETE route, lead emails never exposed without an admin session.
import { afterEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import { sql } from "drizzle-orm";
import { createAuth } from "../src/auth";
import {
  supportLeadRoutes,
  resetLeadRateLimits,
  setLeadRateClock,
} from "../src/routes/support-leads";
import { adminSupportLeadRoutes } from "../src/routes/admin-support-leads";
import { createWorkspace, q, signUp as helpersSignUp, userIdByEmail } from "./helpers";

// These routes are tested standalone (not yet registered in src/app.ts), so
// the shared helpers' buildApp-typed request utilities don't apply; use
// structural minimal types instead.
type AnyApp = { handle: (input: Request) => Promise<Response> };

const send = (
  app: AnyApp,
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
) => {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return app.handle(
    new Request("http://localhost" + path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  );
};
const signUp = (app: AnyApp, email: string, name = "U") => helpersSignUp(app as never, email, name);

let drops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of drops) await d();
  drops = [];
  resetLeadRateLimits();
  setLeadRateClock(Date.now);
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.HBR_TRUST_PROXY;
  globalThis.fetch = realFetch;
});
const realFetch = globalThis.fetch;

const buildLeadApp = (db: Db, auth: ReturnType<typeof createAuth>) =>
  new Elysia()
    .get("/api/auth/*", ({ request }) => auth.handler(request))
    .all("/api/auth/*", ({ request }) => auth.handler(request))
    .use(supportLeadRoutes(db, auth))
    .use(adminSupportLeadRoutes(db, auth));

const POST = "/api/v1/support/integration";
const ADMIN = "/api/v1/admin/support-leads";
const lead = (over: Record<string, unknown> = {}) => ({
  contact_email: "student@example.com",
  message: "Please help us integrate a campus chatbot.",
  ...over,
});

async function made() {
  const t = await createTestDb();
  drops.push(t.drop);
  const auth = createAuth(t.db);
  const app = buildLeadApp(t.db, auth);
  return { db: t.db, app };
}

async function adminCookie(db: Db, app: AnyApp, email: string): Promise<string> {
  // Sign up on the SAME app/db the test uses; a second app here would create
  // the user in a different throwaway database.
  const cookie = await signUp(app, email, "Admin");
  await db.execute(
    sql`INSERT INTO instance_admins (user_id, created_at) VALUES (${await userIdByEmail(db, email)}, ${Date.now()})`,
  );
  return cookie;
}

const stubSiteverify = (accept: boolean) => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).startsWith("https://challenges.cloudflare.com/turnstile/v0/siteverify")) {
      return new Response(JSON.stringify({ success: accept }), { status: 200 });
    }
    return realFetch(input);
  }) as typeof fetch;
};

// bun 1.4.0 raw SQL returns jsonb columns as strings; normalize for assertions.
const asDetail = (d: unknown) =>
  (typeof d === "string" ? JSON.parse(d) : d) as { from: string; to: string };

describe("POST /api/v1/support/integration", () => {
  test("happy path stores an open lead, response leaks nothing sensitive", async () => {
    const { db, app } = await made();
    const res = await send(app, POST, {
      method: "POST",
      body: lead({ contact_channel: "telegram: @student" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("open");
    const rows = await q<{
      contact_email: string;
      status: string;
      workspace_id: null;
      contact_channel: string;
    }>(db, "SELECT contact_email, status, workspace_id, contact_channel FROM support_leads");
    expect(rows.length).toBe(1);
    expect(rows[0]!.contact_email).toBe("student@example.com");
    expect(rows[0]!.contact_channel).toBe("telegram: @student");
    expect(rows[0]!.workspace_id).toBeNull();
  });

  test("invalid bodies -> 400 (bad email, short message, control chars)", async () => {
    const { app } = await made();
    for (const bad of [
      lead({ contact_email: "not-an-email" }),
      lead({ contact_email: "a@b.co\nBcc: victim@x.com" }),
      lead({ message: "short" }),
      lead({ message: "x".repeat(5001) }),
      lead({ contact_channel: "bad\u0000channel" }),
      lead({ contact_email: 42 }),
    ]) {
      // The route rate-limits BEFORE validation by design; reset the cap so
      // each attempt exercises validation, not the 429 path.
      resetLeadRateLimits();
      const res = await send(app, POST, { method: "POST", body: bad });
      expect(res.status).toBe(400);
    }
  });

  test("body over 16KB -> 413", async () => {
    const { app } = await made();
    const res = await send(app, POST, {
      method: "POST",
      body: lead({ message: "x".repeat(17 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  test("rate cap 3 per 10 min per client address, window rollover", async () => {
    const { app } = await made();
    let now = 1_000_000_000;
    setLeadRateClock(() => now);
    for (let i = 0; i < 3; i++) {
      const res = await send(app, POST, { method: "POST", body: lead() });
      expect(res.status).toBe(201);
    }
    const limited = await send(app, POST, { method: "POST", body: lead() });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    // Next window: allowed again.
    now += 10 * 60_000 + 1;
    const rolled = await send(app, POST, { method: "POST", body: lead() });
    expect(rolled.status).toBe(201);
  });

  test("spoofed XFF does not evade the cap unless HBR_TRUST_PROXY=true", async () => {
    const { app } = await made();
    setLeadRateClock(() => 1_000_000_000);
    for (let i = 0; i < 3; i++) {
      await send(app, POST, {
        method: "POST",
        headers: { "x-forwarded-for": `10.0.0.${i}` },
        body: lead(),
      });
    }
    // Untrusted: all three hit the same socket bucket -> 429 despite fresh XFF.
    const spoofed = await send(app, POST, {
      method: "POST",
      headers: { "x-forwarded-for": "10.9.9.9" },
      body: lead(),
    });
    expect(spoofed.status).toBe(429);

    // Trusted proxy: the appended (last) XFF entry is the client address.
    process.env.HBR_TRUST_PROXY = "true";
    const trusted = await send(app, POST, {
      method: "POST",
      headers: { "x-forwarded-for": "10.9.9.9" },
      body: lead(),
    });
    expect(trusted.status).toBe(201);
  });

  test("turnstile: enforced only with TURNSTILE_SECRET_KEY; secret never in response", async () => {
    const { app } = await made();
    // Not configured: tokenless request works.
    const noCaptcha = await send(app, POST, { method: "POST", body: lead() });
    expect(noCaptcha.status).toBe(201);

    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    resetLeadRateLimits();
    const missing = await send(app, POST, { method: "POST", body: lead() });
    expect(missing.status).toBe(400);

    stubSiteverify(false);
    resetLeadRateLimits();
    const rejected = await send(app, POST, {
      method: "POST",
      headers: { "x-captcha-response": "tok" },
      body: lead(),
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.text()).not.toContain("test-secret");

    stubSiteverify(true);
    resetLeadRateLimits();
    const accepted = await send(app, POST, {
      method: "POST",
      headers: { "x-captcha-response": "tok" },
      body: lead(),
    });
    expect(accepted.status).toBe(201);
  });

  test("workspace attach: anonymous value never trusted; member session attaches", async () => {
    const { db, app } = await made();
    const res = await send(app, POST, {
      method: "POST",
      body: lead({ workspace_id: "ws-does-not-exist" }),
    });
    expect(res.status).toBe(201);
    let rows = await q<{ workspace_id: string | null }>(
      db,
      "SELECT workspace_id FROM support_leads",
    );
    expect(rows[0]!.workspace_id).toBeNull();

    // Authorized member: workspace IS attached.
    const ownerEmail = `owner-${crypto.randomUUID()}@example.com`;
    const cookie = await signUp(app, ownerEmail);
    await createWorkspace(db, "ws-1", await userIdByEmail(db, ownerEmail));
    const attached = await send(app, POST, {
      method: "POST",
      cookie,
      body: lead({ workspace_id: "ws-1" }),
    });
    expect(attached.status).toBe(201);
    rows = await q<{ workspace_id: string | null }>(
      db,
      "SELECT workspace_id FROM support_leads ORDER BY created_at DESC LIMIT 1",
    );
    expect(rows[0]!.workspace_id).toBe("ws-1");

    // Session without membership in the requested workspace: dropped.
    const otherEmail = `other-${crypto.randomUUID()}@example.com`;
    const otherCookie = await signUp(app, otherEmail);
    await createWorkspace(db, "ws-2", await userIdByEmail(db, otherEmail));
    await send(app, POST, {
      method: "POST",
      cookie: otherCookie,
      body: lead({ workspace_id: "ws-1" }),
    });
    rows = await q<{ workspace_id: string | null }>(
      db,
      "SELECT workspace_id FROM support_leads ORDER BY created_at DESC LIMIT 1",
    );
    expect(rows[0]!.workspace_id).toBeNull();
  });
});

describe("admin support leads", () => {
  test("no admin session -> 401; non-admin -> 403; lead emails stay private", async () => {
    const { db, app } = await made();
    await send(app, POST, { method: "POST", body: lead() });

    expect((await send(app, ADMIN)).status).toBe(401);
    const userCookie = await signUp(app, `u-${crypto.randomUUID()}@example.com`);
    expect((await send(app, ADMIN, { cookie: userCookie })).status).toBe(403);

    const cookie = await adminCookie(db, app, `admin-${crypto.randomUUID()}@example.com`);
    const res = await send(app, ADMIN, { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { contact_email: string }[] };
    expect(body.data.length).toBe(1);
    expect(body.data[0]!.contact_email).toBe("student@example.com");
  });

  test("status filter + date window + cursor pagination are bounded", async () => {
    const { db, app } = await made();
    const cookie = await adminCookie(db, app, `admin-${crypto.randomUUID()}@example.com`);
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      await db.execute(
        sql`INSERT INTO support_leads (id, contact_email, message, status, created_at) VALUES (${"l" + i}, ${"l" + i + "@x.com"}, ${"message " + i}, ${i % 2 ? "handled" : "open"}, ${t0 + i})`,
      );
    }
    // Bad values rejected, not silently coerced.
    expect((await send(app, `${ADMIN}?status=weird`, { cookie })).status).toBe(400);
    expect((await send(app, `${ADMIN}?from=-5`, { cookie })).status).toBe(400);

    const open = (await (await send(app, `${ADMIN}?status=open&limit=2`, { cookie })).json()) as {
      data: { id: string }[];
      next_before: number;
    };
    expect(open.data.map((r) => r.id)).toEqual(["l4", "l2"]);
    expect(open.next_before).toBe(t0 + 2);

    const windowed = (await (
      await send(app, `${ADMIN}?from=${t0 + 1}&to=${t0 + 3}&limit=200`, { cookie })
    ).json()) as { data: { id: string }[] };
    // from/to are an inclusive window: l1, l2, l3 all fall inside it.
    expect(windowed.data.map((r) => r.id)).toEqual(["l3", "l2", "l1"]);

    const page2 = (await (
      await send(app, `${ADMIN}?status=open&limit=2&before=${open.next_before}`, { cookie })
    ).json()) as {
      data: { id: string }[];
      next_before: number | null;
    };
    expect(page2.data.map((r) => r.id)).toEqual(["l0"]);
    expect(page2.next_before).toBeNull();
  });

  test("PATCH marks handled with actor+handled_at, audits the transition; reopen clears", async () => {
    const { db, app } = await made();
    await send(app, POST, { method: "POST", body: lead() });
    const id = (await q<{ id: string }>(db, "SELECT id FROM support_leads"))[0]!.id;
    const adminEmail = `admin-${crypto.randomUUID()}@example.com`;
    const cookie = await signUp(app, adminEmail);
    const adminId = await userIdByEmail(db, adminEmail);
    await db.execute(
      sql`INSERT INTO instance_admins (user_id, created_at) VALUES (${adminId}, ${Date.now()})`,
    );

    expect(
      (await send(app, `${ADMIN}/${id}`, { method: "PATCH", cookie, body: { status: "bogus" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await send(app, `${ADMIN}/no-such-id`, {
          method: "PATCH",
          cookie,
          body: { status: "handled" },
        })
      ).status,
    ).toBe(404);

    const before = Date.now();
    const res = await send(app, `${ADMIN}/${id}`, {
      method: "PATCH",
      cookie,
      body: { status: "handled" },
    });
    expect(res.status).toBe(200);
    const row = (
      await q<{ status: string; handled_at: number; handled_by: string }>(
        db,
        "SELECT status, handled_at, handled_by FROM support_leads",
      )
    )[0]!;
    expect(row.status).toBe("handled");
    expect(row.handled_by).toBe(adminId);
    expect(row.handled_at).toBeGreaterThanOrEqual(before);

    // Idempotent same-status PATCH: no duplicate audit row.
    await send(app, `${ADMIN}/${id}`, { method: "PATCH", cookie, body: { status: "handled" } });
    let audits = await q<{ action: string; detail: unknown }>(
      db,
      "SELECT action, detail FROM audit_log WHERE target = ? ORDER BY created_at",
      id,
    );
    expect(audits.length).toBe(1);
    expect(audits[0]!.action).toBe("support_lead.status");
    expect(asDetail(audits[0]!.detail)).toEqual({ from: "open", to: "handled" });

    // Reopen clears the handling record, also audited.
    await send(app, `${ADMIN}/${id}`, { method: "PATCH", cookie, body: { status: "open" } });
    const reopened = (
      await q<{ status: string; handled_at: number | null; handled_by: string | null }>(
        db,
        "SELECT status, handled_at, handled_by FROM support_leads",
      )
    )[0]!;
    expect(reopened.status).toBe("open");
    expect(reopened.handled_at).toBeNull();
    expect(reopened.handled_by).toBeNull();
    audits = await q<{ action: string; detail: unknown }>(
      db,
      "SELECT action, detail FROM audit_log WHERE target = ? ORDER BY created_at",
      id,
    );
    expect(audits.length).toBe(2);
    expect(asDetail(audits[1]!.detail)).toEqual({ from: "handled", to: "open" });
  });

  test("no DELETE route on leads", async () => {
    const { db, app } = await made();
    const cookie = await adminCookie(db, app, `admin-${crypto.randomUUID()}@example.com`);
    const res = await send(app, `${ADMIN}/some-id`, { method: "DELETE", cookie });
    expect([404, 405]).toContain(res.status);
  });
});
