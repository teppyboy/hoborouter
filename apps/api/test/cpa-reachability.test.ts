import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { makeApp, signUp, req, createWorkspace, makeInstanceAdmin, userIdByEmail } from "./helpers";

test("cpa health: member and workspace admin get 403", async () => {
  const { db, app } = await makeApp();
  const memberCookie = await signUp(app, "m@example.com");
  await createWorkspace(db, "ws1", await userIdByEmail(db, "m@example.com"));
  expect((await req(app, "/api/v1/admin/cpa/health", { cookie: memberCookie })).status).toBe(403);
  const wsAdminCookie = await signUp(app, "wsadmin@example.com");
  const { addMember } = await import("./helpers");
  await addMember(db, "ws1", await userIdByEmail(db, "wsadmin@example.com"), "admin");
  expect((await req(app, "/api/v1/admin/cpa/health", { cookie: wsAdminCookie })).status).toBe(403);
});

test("cpa health: instance admin makes each upstream request once", async () => {
  let healthzHits = 0;
  let mgmtHits = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/healthz") {
        healthzHits++;
        return Response.json({ status: "ok" });
      }
      if (path === "/v0/management/config") {
        mgmtHits++;
        return new Response("unauthorized", { status: 401 });
      }
      return new Response("nf", { status: 404 });
    },
  });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${server.port}`;
  process.env.CPA_MANAGEMENT_KEY = "test-only-not-a-real-secret";
  try {
    const { db, app } = await makeApp();
    const adminCookie = await signUp(app, "admin@example.com");
    await makeInstanceAdmin(db, await userIdByEmail(db, "admin@example.com"));
    const res = await req(app, "/api/v1/admin/cpa/health", { cookie: adminCookie });
    expect(res.status).toBe(502);
    expect(healthzHits).toBe(1);
    expect(mgmtHits).toBe(1);
    const body = await res.json();
    expect(body.error?.code).toBe("CPA_AUTH_FAILED");
    expect(body.error?.message).toBe("CPA rejected CPA_MANAGEMENT_KEY (401)");
  } finally {
    server.stop(true);
    delete process.env.CPA_BASE_URL;
    delete process.env.CPA_MANAGEMENT_KEY;
  }
});

test("generic thrown error still masks as 500 INTERNAL_ERROR", async () => {
  const { app } = await makeApp();
  app.get("/test/boom", () => {
    throw new Error("secret-detail");
  });
  const res = await req(app, "/test/boom");
  const body = await res.json();
  expect(res.status).toBe(500);
  expect(body.error?.code).toBe("INTERNAL_ERROR");
  expect(body.error?.message).toBe("Internal server error");
  expect(JSON.stringify(body)).not.toContain("secret-detail");
});

test("cpa health: healthy CPA returns labeled fields", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/healthz") return Response.json({ status: "ok" });
      if (path === "/v0/management/config") {
        if (req.headers.get("authorization") !== "Bearer test-only-not-a-real-secret")
          return new Response("unauthorized", { status: 401 });
        return Response.json({ config: "body-contents-never-proxied" });
      }
      return new Response("nf", { status: 404 });
    },
  });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${server.port}`;
  process.env.CPA_MANAGEMENT_KEY = "test-only-not-a-real-secret";
  try {
    const { db, app } = await makeApp();
    const cookie = await signUp(app, "healthy-admin@example.com");
    await makeInstanceAdmin(db, await userIdByEmail(db, "healthy-admin@example.com"));
    const res = await req(app, "/api/v1/admin/cpa/health", { cookie });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.proxy_endpoint).toEqual({ healthy: true, http_status: 200 });
    expect(body.management_api).toEqual({ healthy: true, http_status: 200 });
    expect(typeof body.latency_ms).toBe("number");
    expect(body.cpa_host).toBe(`127.0.0.1:${server.port}`);
    expect(Number.isNaN(Date.parse(body.checked_at))).toBe(false);
    expect(JSON.stringify(body)).not.toContain("test-only-not-a-real-secret");
    expect(JSON.stringify(body)).not.toContain("body-contents-never-proxied");
  } finally {
    server.stop(true);
    delete process.env.CPA_BASE_URL;
    delete process.env.CPA_MANAGEMENT_KEY;
  }
});

test("cpa health: unreachable CPA → 502", async () => {
  process.env.CPA_BASE_URL = "http://127.0.0.1:1";
  process.env.CPA_MANAGEMENT_KEY = "test-only-not-a-real-secret";
  try {
    const { db, app } = await makeApp();
    const cookie = await signUp(app, "admin2@example.com");
    await makeInstanceAdmin(db, await userIdByEmail(db, "admin2@example.com"));
    expect((await req(app, "/api/v1/admin/cpa/health", { cookie })).status).toBe(502);
  } finally {
    delete process.env.CPA_BASE_URL;
    delete process.env.CPA_MANAGEMENT_KEY;
  }
});

test("compose publishes CPA on loopback only", async () => {
  const text = await Bun.file("deploy/docker-compose.yml").text();
  if (typeof Bun.YAML === "object") {
    const compose = Bun.YAML.parse(text) as {
      services?: Record<string, { ports?: string[] }>;
    };
    const cpa = compose.services?.cpa;
    expect(cpa).toBeDefined();
    expect(cpa?.ports?.length ?? 0).toBeGreaterThan(0);
    for (const port of cpa?.ports ?? []) expect(port).toMatch(/^127\.0\.0\.1:/);
    return;
  }

  const docker = Bun.spawnSync(["docker", "--version"]);
  if (docker.exitCode !== 0) return;
  expect(
    Bun.spawnSync(["docker", "compose", "-f", "deploy/docker-compose.yml", "config", "-q"])
      .exitCode,
  ).toBe(0);
});

test("deploy/: no committed secrets, rendered config untracked", async () => {
  expect(
    Bun.spawnSync(["git", "check-ignore", "deploy/cpa/config.yaml", "deploy/.env"]).exitCode,
  ).toBe(0);
  const tracked = Bun.spawnSync(["git", "ls-files", "deploy/"])
    .stdout.toString()
    .trim()
    .split("\n")
    .filter((f) => f && existsSync(f));
  for (const f of tracked) {
    if (f === "deploy/cpa/config.example.yaml" || f === "deploy/cpa/render-config.sh") continue;
    const text = await Bun.file(f).text();
    expect(text).not.toContain("your-api-key");
    expect(text).not.toMatch(/\$\{CPA_/);
  }
});
