import { afterEach, describe, expect, test } from "bun:test";
import { makeApp } from "./helpers";

// Close each test's pool after the test: Bun SQL pools hold connections until
// closed and the test Postgres has a finite connection budget.
let drops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of drops) await d();
  drops = [];
});
const newApp = async () => {
  const made = await makeApp();
  drops.push(made.close);
  return made;
};

const request = (
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  path: string,
  init: RequestInit = {},
) => app.handle(new Request(`http://localhost${path}`, init));

describe("security middleware", () => {
  test("strips inbound tracing/request IDs before Better Auth sees them", async () => {
    const { app, auth } = await newApp();
    let seen = new Headers();
    const original = auth.handler;
    auth.handler = async (req) => {
      seen = new Headers(req.headers);
      return original(req);
    };
    const res = await request(app, "/api/auth/get-session", {
      headers: {
        "X-CPA-TRACE-ID": "attacker-trace",
        "X-Request-Id": "attacker-request",
        "OpenAI-Request-Id": "attacker-openai",
      },
    });
    expect(res.headers.get("x-hbr-request-id")).toMatch(/^[0-9a-f-]{36}$/i);
    expect(seen.has("x-cpa-trace-id")).toBe(false);
    expect(seen.has("x-request-id")).toBe(false);
    expect(seen.has("openai-request-id")).toBe(false);
  });

  test("GET auth endpoints reach Better Auth; unknown /api/v1 stays 404", async () => {
    const { app } = await newApp();
    const res = await request(app, "/api/auth/get-session");
    expect(res.status).toBe(200);
    expect(await res.json()).toBe(null);
    const missing = await request(app, "/api/v1/nonexistent");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("NOT_FOUND");
  });

  test("normalizes 404 and authz 403 errors with request ID", async () => {
    const { app } = await newApp();
    for (const path of ["/api/missing", "/api/v1/workspaces/no-such-id/members"]) {
      const res = await request(app, path);
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = await res.json();
      expect(body.error.code).toBeTruthy();
      expect(body.error.message).toBeTruthy();
      expect(body.error.request_id).toBe(res.headers.get("x-hbr-request-id"));
      expect(JSON.stringify(body)).not.toContain("stack");
    }
  });

  test("preserves native redirects, Location, and multiple cookies", async () => {
    const { app } = await newApp();
    app.get(
      "/test/redirect",
      () =>
        new Response(null, {
          status: 302,
          headers: [
            ["location", "/login"],
            ["set-cookie", "first=1; Path=/"],
            ["set-cookie", "second=2; Path=/"],
          ],
        }),
    );
    const res = await request(app, "/test/redirect");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.headers.getSetCookie()).toEqual(["first=1; Path=/", "second=2; Path=/"]);
  });

  test("normalizes server errors without exposing details", async () => {
    const { app } = await newApp();
    app.get("/test/failure", () => {
      throw new Error("private failure stack");
    });
    const res = await request(app, "/test/failure");
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error");
    expect(body.error.request_id).toBe(res.headers.get("x-hbr-request-id"));
    expect(JSON.stringify(body)).not.toContain("private failure");
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  test("adds UUID request ID to successful and static responses", async () => {
    const { app } = await newApp();
    for (const path of ["/healthz", "/"]) {
      expect((await request(app, path)).headers.get("x-hbr-request-id")).toMatch(
        /^[0-9a-f-]{36}$/i,
      );
    }
  });

  test("keeps 304 and HEAD responses bodyless", async () => {
    const { app } = await newApp();
    app.get("/test/not-modified", () => new Response(null, { status: 304 }));
    expect(await (await request(app, "/test/not-modified")).text()).toBe("");
    expect(await (await request(app, "/", { method: "HEAD" })).text()).toBe("");
  });

  test("does not document paid proxy POST routes", async () => {
    const { app } = await newApp();
    const doc = await (await request(app, "/openapi.json")).json();
    for (const [path, methods] of Object.entries(doc.paths ?? {}) as [
      string,
      { post?: unknown },
    ][]) {
      if (path === "/v1/chat/completions" || path === "/v1/responses") {
        expect(methods.post).toBeUndefined();
      }
    }
  });
});
