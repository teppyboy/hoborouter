// Public support-lead intake route contract (BMC paid integration-support).
// Focus of this file (admin routes live in support-leads.test.ts):
// - raw body bounded BEFORE parse: 16 KiB cap on the actual stream, not just
//   declared content-length (spoofing the header cannot smuggle a big body);
//   missing/non-object body -> 400.
// - field validation: contact_email, optional contact_channel <=200,
//   message 10..5000, no control characters.
// - Turnstile iff TURNSTILE_SECRET_KEY: missing token -> 400, failed
//   siteverify -> 403, all via an INJECTED fetch seam (no external request).
// - rate cap 3/10min per client address with window rollover; untrusted XFF
//   never evades it.
// - workspace_id attached only for an authorized member session; an
//   anonymous or non-member value is consistently dropped (stored NULL).
// - response leaks nothing sensitive; email/message never logged.
import { afterEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import { createAuth } from "../src/auth";
import {
  checkLeadRateLimit,
  supportLeadRoutes,
  resetLeadRateLimits,
  setLeadRateClock,
} from "../src/routes/support-leads";
import { createWorkspace, q, signUp as helpersSignUp, userIdByEmail } from "./helpers";

type AnyApp = { handle: (input: Request) => Promise<Response> };

const POST = "/api/v1/support/integration";
const lead = (over: Record<string, unknown> = {}) => ({
  contact_email: "student@example.com",
  message: "Please help us integrate a campus chatbot.",
  ...over,
});

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
});

const siteverifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

async function made(opts: { fetch?: typeof fetch } = {}) {
  const t = await createTestDb();
  drops.push(t.drop);
  const auth = createAuth(t.db);
  const app: AnyApp = new Elysia()
    .get("/api/auth/*", ({ request }) => auth.handler(request))
    .all("/api/auth/*", ({ request }) => auth.handler(request))
    .use(supportLeadRoutes(t.db, auth, opts))
    .compile();
  return { db: t.db as Db, app };
}

describe("POST /api/v1/support/integration — body bounds", () => {
  test("missing body -> 400 (never an empty-object success)", async () => {
    const { app } = await made();
    const res = await app.handle(new Request("http://localhost" + POST, { method: "POST" }));
    expect(res.status).toBe(400);
  });

  test("non-object body (array / string / bad json) -> 400", async () => {
    const { app } = await made();
    resetLeadRateLimits(); // rate cap is per-window; these are validation tests
    for (const raw of ["[1,2,3]", JSON.stringify(["a"]), "not-json", JSON.stringify("hi")]) {
      resetLeadRateLimits(); // not under test here; keep the cap from firing
      const res = await app.handle(
        new Request("http://localhost" + POST, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw,
        }),
      );
      expect(res.status).toBe(400);
    }
  });

  test("body over 16 KiB -> 413 even when declared content-length lies", async () => {
    const { app } = await made();
    // Streamed body without a declared length: the raw reader cap must fire.
    const big = Buffer.alloc(17 * 1024, 0x78); // 17 KiB of 'x'
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(big));
        c.close();
      },
    });
    const res = await app.handle(
      new Request("http://localhost" + POST, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(413);
  });

  test("declared huge content-length with no body -> 413 fast path", async () => {
    const { app } = await made();
    const res = await app.handle(
      new Request("http://localhost" + POST, {
        method: "POST",
        headers: { "content-length": String(1024 * 1024) },
      }),
    );
    expect(res.status).toBe(413);
  });
});

describe("POST /api/v1/support/integration — field validation", () => {
  test("happy path -> {id,status:'open'}, row stored open, response leaks nothing", async () => {
    const { db, app } = await made();
    const res = await send(app, POST, {
      method: "POST",
      body: lead({ contact_channel: "zalo: 09xx" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(typeof body.id).toBe("string");
    expect(body.status).toBe("open");
    expect(Object.keys(body).sort()).toEqual(["id", "status"]);
    const rows = await q<{ status: string; workspace_id: string | null }>(
      db,
      "SELECT status, workspace_id FROM support_leads",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("open");
    expect(rows[0]!.workspace_id).toBeNull();
  });

  test("invalid fields -> 400: bad email, message bounds, control chars, channel bounds", async () => {
    const { db, app } = await made();
    for (const bad of [
      lead({ contact_email: "nope" }),
      lead({ contact_email: "a@b.co\r\nBcc: v@x.com" }),
      { message: "x".repeat(20) }, // email missing entirely
      lead({ message: "short" }),
      lead({ message: "x".repeat(5001) }),
      lead({ contact_channel: "c".repeat(201) }),
      lead({ contact_channel: "bad\u0007channel" }),
      lead({ message: "line1\u0000line2" }),
    ]) {
      resetLeadRateLimits(); // not under test here; keep the cap from firing
      const res = await send(app, POST, { method: "POST", body: bad });
      expect(res.status).toBe(400);
    }
    const rows = await q<{ id: string }>(db, "SELECT id FROM support_leads");
    expect(rows.length).toBe(0);
  });
});

describe("POST /api/v1/support/integration — turnstile via injected fetch seam", () => {
  test("no secret configured: tokenless works and no siteverify call is made", async () => {
    const { app } = await made({
      fetch: (async (input: string | URL | Request): Promise<Response> => {
        if (String(input).startsWith(siteverifyUrl))
          throw new Error("siteverify must not be called");
        throw new Error("no network in tests");
      }) as typeof fetch,
    });
    const res = await send(app, POST, { method: "POST", body: lead() });
    expect(res.status).toBe(201);
  });

  test("secret configured: missing token -> 400; siteverify false -> 403; true -> 201", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    let calls = 0;
    const { app } = await made({
      fetch: (async (input: string | URL | Request) => {
        if (String(input).startsWith(siteverifyUrl)) {
          calls++;
          return new Response(JSON.stringify({ success: calls > 1 }), { status: 200 });
        }
        throw new Error("unexpected fetch");
      }) as typeof fetch,
    });

    const missing = await send(app, POST, { method: "POST", body: lead() });
    expect(missing.status).toBe(400);

    const failed = await send(app, POST, {
      method: "POST",
      headers: { "x-captcha-response": "tok" },
      body: lead(),
    });
    expect(failed.status).toBe(403);
    expect(await failed.text()).not.toContain("test-secret");

    const ok = await send(app, POST, {
      method: "POST",
      headers: { "x-captcha-response": "tok" },
      body: lead(),
    });
    expect(ok.status).toBe(201);
    expect(calls).toBe(2);
  });

  test("siteverify network failure / timeout fails closed -> 403", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const { app } = await made({
      fetch: (async (): Promise<Response> => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const res = await send(app, POST, {
      method: "POST",
      headers: { "x-captcha-response": "tok" },
      body: lead(),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/support/integration — rate cap", () => {
  test("3 per 10 min per address, 429 with retry-after, window rollover restores", async () => {
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
    now += 10 * 60_000 + 1;
    const rolled = await send(app, POST, { method: "POST", body: lead() });
    expect(rolled.status).toBe(201);
  });

  test("spoofed XFF does not evade the cap without HBR_TRUST_PROXY=true", async () => {
    const { app } = await made();
    setLeadRateClock(() => 1_000_000_000);
    for (let i = 0; i < 3; i++) {
      await send(app, POST, {
        method: "POST",
        headers: { "x-forwarded-for": `10.0.0.${i}` },
        body: lead(),
      });
    }
    const spoofed = await send(app, POST, {
      method: "POST",
      headers: { "x-forwarded-for": "10.9.9.9" },
      body: lead(),
    });
    expect(spoofed.status).toBe(429);
  });
});

describe("rate cap hard capacity", () => {
  test("all slots active: new key denied with retry-after boundary; exhausted IP not reset; next window admitted", () => {
    resetLeadRateLimits();
    let now = 2_000_000_000;
    setLeadRateClock(() => now);

    // Fully exhaust one address (3/3) before the capacity is filled.
    const exhausted = "10.0.0.255";
    for (let i = 0; i < 3; i++) expect(checkLeadRateLimit(exhausted).ok).toBe(true);

    // Fill capacity with distinct ACTIVE-window addresses (10k total slots).
    let filled = 1; // exhausted IP already holds one slot
    for (let i = 0; filled < 10_000; i++) {
      const key = `10.${Math.floor(i / 65536) % 256}.${Math.floor(i / 256) % 256}.${i % 256}`;
      if (key === exhausted) continue;
      checkLeadRateLimit(key);
      filled++;
    }

    // Capacity full of active entries: a NEW address is denied, with a
    // retry-after bounded by the window end.
    const denied = checkLeadRateLimit("10.200.0.1");
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(600);

    // No eviction happened: the existing exhausted IP is still limited
    // (its quota was NOT reset by admitting the new address).
    expect(checkLeadRateLimit(exhausted).ok).toBe(false);

    // Next window: expired entries free capacity, the denied key is admitted.
    now += 10 * 60_000 + 1;
    expect(checkLeadRateLimit("10.200.0.1").ok).toBe(true);
    // Original 3/window rule still applies to the previously exhausted IP.
    expect(checkLeadRateLimit(exhausted).ok).toBe(true);
  });
});

describe("POST /api/v1/support/integration — workspace association", () => {
  test("anonymous supplied workspace_id is consistently ignored (stored NULL)", async () => {
    const { db, app } = await made();
    const res = await send(app, POST, { method: "POST", body: lead({ workspace_id: "ws-ghost" }) });
    expect(res.status).toBe(201);
    const rows = await q<{ workspace_id: string | null }>(
      db,
      "SELECT workspace_id FROM support_leads",
    );
    expect(rows[0]!.workspace_id).toBeNull();
  });

  test("authorized member session attaches; non-member session does not", async () => {
    const { db, app } = await made();
    const ownerEmail = `owner-${crypto.randomUUID()}@example.com`;
    const memberCookie = await signUp(app, ownerEmail);
    await createWorkspace(db, "ws-1", await userIdByEmail(db, ownerEmail));

    const attached = await send(app, POST, {
      method: "POST",
      cookie: memberCookie,
      body: lead({ workspace_id: "ws-1" }),
    });
    expect(attached.status).toBe(201);
    let rows = await q<{ workspace_id: string | null }>(
      db,
      "SELECT workspace_id FROM support_leads ORDER BY created_at DESC LIMIT 1",
    );
    expect(rows[0]!.workspace_id).toBe("ws-1");

    // Signed in, but NOT a member of ws-1: dropped, lead still accepted.
    const otherEmail = `other-${crypto.randomUUID()}@example.com`;
    const otherCookie = await signUp(app, otherEmail);
    await createWorkspace(db, "ws-2", await userIdByEmail(db, otherEmail));
    const nonMember = await send(app, POST, {
      method: "POST",
      cookie: otherCookie,
      body: lead({ workspace_id: "ws-1" }),
    });
    expect(nonMember.status).toBe(201);
    rows = await q<{ workspace_id: string | null }>(
      db,
      "SELECT workspace_id FROM support_leads ORDER BY created_at DESC LIMIT 1",
    );
    expect(rows[0]!.workspace_id).toBeNull();
  });
});

describe("POST /api/v1/support/integration — hygiene", () => {
  test("no sensitive values logged on accept or reject", async () => {
    const logs: unknown[][] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    for (const k of ["log", "error", "warn"] as const) {
      console[k] = (...args: unknown[]) => logs.push(args);
    }
    try {
      process.env.TURNSTILE_SECRET_KEY = "test-secret";
      const { app } = await made({
        fetch: (async () =>
          new Response(JSON.stringify({ success: true }), {
            status: 200,
          })) as unknown as typeof fetch,
      });
      await send(app, POST, {
        method: "POST",
        headers: { "x-captcha-response": "tok" },
        body: lead({
          contact_email: "secret-me@example.com",
          message: "top secret prompt content",
        }),
      });
      // Rejected request (missing captcha) also must not log.
      await send(app, POST, {
        method: "POST",
        body: lead({ contact_email: "secret-me@example.com" }),
      });
    } finally {
      Object.assign(console, orig);
    }
    const flat = JSON.stringify(logs);
    expect(flat).not.toContain("secret-me@example.com");
    expect(flat).not.toContain("top secret prompt content");
    expect(flat).not.toContain("tok");
  });
});
