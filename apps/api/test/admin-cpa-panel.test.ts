import { expect, test } from "bun:test";
import type { Db } from "@hoborouter/db";
import type { BetterAuthInstance } from "../src/auth-types";
import { adminCpaPanelRoutes } from "../src/routes/admin-cpa-panel";

function setup() {
  let admin = true;
  let authenticated = true;
  let session = "session";
  const audits: unknown[] = [];
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (admin ? [{ one: "admin" }] : []) }) }),
    }),
    insert: () => ({
      values: async (value: unknown) => {
        audits.push(value);
      },
    }),
  } as unknown as Db;
  const auth: BetterAuthInstance = {
    handler: async () => new Response(),
    api: {
      getSession: async () =>
        authenticated ? { user: { id: "admin" }, session: { id: session, userId: "admin" } } : null,
    },
  };
  let hits = 0;
  let fetcher: (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => Promise<Response> = async () => {
    hits++;
    return Response.json({ debug: false });
  };
  const app = adminCpaPanelRoutes(
    db,
    auth,
    {
      BETTER_AUTH_URL: "https://admin.test",
      CPA_MANAGEMENT_KEY: 'sentinel"\\key',
      CPA_BASE_URL: "https://fake.invalid",
    },
    async (input, init) => fetcher(input, init),
  );
  const request = (suffix: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.handle(
      new Request(`https://admin.test/api/v1/admin/cpa/panel/${suffix}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { origin: "https://admin.test", "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return {
    request,
    audits,
    hits: () => hits,
    setFetcher: (value: typeof fetcher) => {
      fetcher = value;
    },
    demote: () => {
      admin = false;
    },
    logout: () => {
      authenticated = false;
    },
    session: (value: string) => {
      session = value;
    },
  };
}

test("panel session, auth/admin/CSRF/Origin/schema gates fail without upstream calls", async () => {
  const s = setup();
  const token = (await (await s.request("session")).json()).csrf_token;
  for (const [body, headers] of [
    [{ operation: "readConfig" }, {}],
    [{ operation: "readConfig" }, { "x-hbr-panel-csrf": "wrong" }],
    [{ operation: "readConfig" }, { "x-hbr-panel-csrf": token, origin: "null" }],
    [{ operation: "readConfig" }, { "x-hbr-panel-csrf": token, origin: "https://evil.test" }],
    [{ operation: "readConfig", url: "https://evil.test" }, { "x-hbr-panel-csrf": token }],
    [{ operation: "readConfig" }, { "x-hbr-panel-csrf": token, "content-type": "text/plain" }],
  ] as [unknown, Record<string, string>][])
    expect((await s.request("read", body, headers)).status).toBeGreaterThanOrEqual(400);
  s.session("other");
  expect(
    (await s.request("read", { operation: "readConfig" }, { "x-hbr-panel-csrf": token })).status,
  ).toBe(403);
  s.demote();
  expect((await s.request("session")).status).toBe(403);
  s.logout();
  expect((await s.request("session")).status).toBe(401);
  expect(s.hits()).toBe(0);
});

test("read is projected/no-store; prepare never dispatches; demotion denies execute", async () => {
  const s = setup();
  const token = (await (await s.request("session")).json()).csrf_token;
  const headers = { "x-hbr-panel-csrf": token };
  const read = await s.request("read", { operation: "readConfig" }, headers);
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toBe("no-store");
  expect(await read.json()).toEqual({ data: { debug: false } });
  const prepared = await s.request(
    "prepare",
    { operation: "replaceModelAliases", args: { channel: "codex", aliases: [] } },
    headers,
  );
  const { approval_id } = await prepared.json();
  expect(prepared.status).toBe(200);
  expect(s.hits()).toBe(1);
  s.demote();
  expect((await s.request("execute", { approval_id }, headers)).status).toBe(403);
  expect(s.hits()).toBe(1);
  expect(JSON.stringify(s.audits)).not.toContain("sentinel");
});

test("execute setAuthFileStatus returns echoed name/disabled; upstream failure propagates", async () => {
  const s = setup();
  const token = (await (await s.request("session")).json()).csrf_token;
  const headers = { "x-hbr-panel-csrf": token };
  s.setFetcher(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "GET")
      return Response.json({
        files: [
          {
            name: "fake.json",
            type: "codex",
            provider: "codex",
            disabled: false,
            status: "active",
          },
        ],
      });
    if (request.method === "PATCH") return Response.json({ status: "ok" });
    return Response.json({ error: "boom" }, { status: 500 });
  });
  for (const disabled of [true, false]) {
    const prepared = await s.request(
      "prepare",
      { operation: "setAuthFileStatus", args: { name: "fake.json", disabled } },
      headers,
    );
    const { approval_id } = await prepared.json();
    const executed = await s.request("execute", { approval_id }, headers);
    expect(executed.status).toBe(200);
    expect(await executed.json()).toEqual({ data: { ok: true, name: "fake.json", disabled } });
  }
  const failed = await s.request(
    "prepare",
    { operation: "setAuthFileStatus", args: { name: "fake.json", disabled: true } },
    headers,
  );
  const { approval_id } = await failed.json();
  s.setFetcher(async () => Response.json({ error: "boom" }, { status: 500 }));
  expect((await s.request("execute", { approval_id }, headers)).status).toBe(502);
  expect(JSON.stringify(s.audits)).not.toContain("sentinel");
});

test("asset uses HTTP sandbox, exact script hashes, no network or untrusted frame ancestor", async () => {
  const s = setup();
  const response = await s.request("management.html");
  expect(response.status).toBe(200);
  const csp = response.headers.get("content-security-policy")!;
  for (const directive of [
    "sandbox allow-scripts",
    "connect-src 'none'",
    "frame-ancestors https://admin.test",
    "worker-src 'none'",
    "form-action 'none'",
  ])
    expect(csp).toContain(directive);
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).not.toContain("script-src 'unsafe-inline'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(2);
  for (const script of scripts)
    expect(csp).toContain(
      `'sha256-${new Bun.CryptoHasher("sha256").update(script[1]!).digest("base64")}'`,
    );
  s.logout();
  expect((await s.request("management.html")).status).toBe(401);
});
