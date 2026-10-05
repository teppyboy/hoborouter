// Focused behavior tests for admin CPA mutation routes (admin-cpa-mutations.ts).
// Uses an in-process fake CPA that records every management hit; asserts
// allowlisted forwarding, admin gating, confirm gates, secret redaction in
// audit rows, and preservation of upstream error statuses.
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog } from "@hoborouter/db";
import {
  makeApp,
  signUp,
  req,
  createWorkspace,
  makeInstanceAdmin,
  userIdByEmail,
  addMember,
} from "./helpers";
import { adminCpaMutationRoutes } from "../src/routes/admin-cpa-mutations";

type Hit = {
  method: string;
  path: string;
  query: string;
  body: string | null;
  auth: string | null;
};

const MGMT = "test-only-not-a-real-secret";

/** Fake CPA on an ephemeral port; env vars are restored by the caller. */
function fakeCpa(opts: { status?: number; body?: unknown } = {}) {
  const hits: Hit[] = [];
  const status = opts.status ?? 200;
  const body = opts.body ?? { status: "ok", contains: "upstream-secret-never-proxied" };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (!path.startsWith("/v0/management")) return new Response("nf", { status: 404 });
      if ((req.headers.get("authorization") ?? "") !== `Bearer ${MGMT}`)
        return Response.json({ error: "unauthorized" }, { status: 401 });
      return req.text().then((raw) => {
        hits.push({
          method: req.method,
          path,
          query: url.search,
          body: raw === "" ? null : raw,
          auth: req.headers.get("authorization"),
        });
        if (status >= 400) return Response.json({ error: "upstream said no" }, { status });
        return Response.json(body);
      });
    },
  });
  return {
    hits,
    /** Indexed access that satisfies noUncheckedIndexedAccess in tests. */
    hit: (i: number) => {
      const h = hits[i];
      if (!h) throw new Error(`expected upstream hit #${i}`);
      return h;
    },
    base: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

async function adminSetup() {
  const fake = fakeCpa();
  process.env.CPA_BASE_URL = fake.base;
  process.env.CPA_MANAGEMENT_KEY = MGMT;
  const { db, app, auth } = await makeApp();
  app.use(adminCpaMutationRoutes(db, auth));
  const cookie = await signUp(app, "cpa-admin@example.com");
  await makeInstanceAdmin(db, await userIdByEmail(db, "cpa-admin@example.com"));
  return { db, app, cookie, fake };
}

function cleanup(fake: { stop: () => void }) {
  fake.stop();
  delete process.env.CPA_BASE_URL;
  delete process.env.CPA_MANAGEMENT_KEY;
}

async function lastAudit(db: Awaited<ReturnType<typeof makeApp>>["db"], action: string) {
  const rows = await db.select().from(auditLog).where(eq(auditLog.action, action));
  return rows[rows.length - 1] ?? null;
}

test("mutations require instance admin (member and ws admin get 403)", async () => {
  const fake = fakeCpa();
  process.env.CPA_BASE_URL = fake.base;
  process.env.CPA_MANAGEMENT_KEY = MGMT;
  try {
    const { db, app, auth } = await makeApp();
    app.use(adminCpaMutationRoutes(db, auth));
    const memberCookie = await signUp(app, "m2@example.com");
    await createWorkspace(db, "ws2", await userIdByEmail(db, "m2@example.com"));
    expect(
      (
        await req(app, "/api/v1/admin/cpa/routing/strategy", {
          method: "PUT",
          cookie: memberCookie,
          body: { strategy: "round-robin" },
        })
      ).status,
    ).toBe(403);
    const wsAdminCookie = await signUp(app, "wsadmin2@example.com");
    await addMember(db, "ws2", await userIdByEmail(db, "wsadmin2@example.com"), "admin");
    expect(
      (
        await req(app, "/api/v1/admin/cpa/routing/strategy", {
          method: "PUT",
          cookie: wsAdminCookie,
          body: { strategy: "round-robin" },
        })
      ).status,
    ).toBe(403);
    // Unauthenticated too.
    expect(
      (
        await req(app, "/api/v1/admin/cpa/routing/strategy", {
          method: "PUT",
          body: { strategy: "round-robin" },
        })
      ).status,
    ).toBe(401);
    expect(fake.hits.length).toBe(0);
  } finally {
    cleanup(fake);
  }
});

test("dangerous ops without confirm:true are rejected before any upstream call", async () => {
  const { app, cookie, fake } = await adminSetup();
  try {
    const noConfirm = await req(app, "/api/v1/admin/cpa/config", {
      method: "PUT",
      cookie,
      body: { config_yaml: "debug: false\n" },
    });
    expect(noConfirm.status).toBe(400);
    const falseConfirm = await req(app, "/api/v1/admin/cpa/auth-files", {
      method: "DELETE",
      cookie,
      body: { names: ["a.json"], confirm: false },
    });
    expect(falseConfirm.status).toBe(400);
    expect(fake.hits.length).toBe(0);
  } finally {
    cleanup(fake);
  }
});

test("config save forwards YAML to the allowlisted path and audits without the YAML body", async () => {
  const { db, app, cookie, fake } = await adminSetup();
  try {
    const res = await req(app, "/api/v1/admin/cpa/config", {
      method: "PUT",
      cookie,
      body: { config_yaml: "debug: false\nsecret-key: should-not-be-audited\n", confirm: true },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fake.hits.length).toBe(1);
    expect(fake.hit(0).method).toBe("PUT");
    expect(fake.hit(0).path).toBe("/v0/management/config.yaml");
    expect(fake.hit(0).body).toBe("debug: false\nsecret-key: should-not-be-audited\n");
    const audit = await lastAudit(db, "cpa.config.save");
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.detail)).not.toContain("should-not-be-audited");
  } finally {
    cleanup(fake);
  }
});

test("flag toggle and retry fields forward to exact flat endpoints", async () => {
  const { app, cookie, fake } = await adminSetup();
  try {
    const res = await req(app, "/api/v1/admin/cpa/config/flags", {
      method: "PATCH",
      cookie,
      body: { flag: "debug", value: true },
    });
    expect(res.status).toBe(200);
    expect(fake.hit(0)).toMatchObject({
      method: "PUT",
      path: "/v0/management/debug",
      body: '{"value":true}',
    });
    const retry = await req(app, "/api/v1/admin/cpa/config/retry", {
      method: "PUT",
      cookie,
      body: { request_retry: 3, max_retry_interval: 10 },
    });
    expect(retry.status).toBe(200);
    expect([fake.hit(1), fake.hit(2)]).toEqual([
      {
        method: "PUT",
        path: "/v0/management/request-retry",
        body: '{"value":3}',
        query: "",
        auth: `Bearer ${MGMT}`,
      },
      {
        method: "PUT",
        path: "/v0/management/max-retry-interval",
        body: '{"value":10}',
        query: "",
        auth: `Bearer ${MGMT}`,
      },
    ]);
  } finally {
    cleanup(fake);
  }
});

test("api key add/rotate/delete: forwarded, confirmed, audited without the key value", async () => {
  const { db, app, cookie, fake } = await adminSetup();
  try {
    const add = await req(app, "/api/v1/admin/cpa/api-keys", {
      method: "PATCH",
      cookie,
      body: { new: "sk-hbr-new-secret-value" },
    });
    expect(add.status).toBe(200);
    expect(fake.hit(0)).toMatchObject({ method: "PATCH", path: "/v0/management/api-keys" });
    const addBody = JSON.parse(fake.hit(0).body ?? "{}");
    expect(addBody).toEqual({ old: "sk-hbr-new-secret-value", new: "sk-hbr-new-secret-value" });

    const del = await req(app, "/api/v1/admin/cpa/api-keys", {
      method: "DELETE",
      cookie,
      body: { key: "sk-hbr-new-secret-value", confirm: true },
    });
    expect(del.status).toBe(200);
    expect(fake.hit(1).method).toBe("DELETE");
    expect(fake.hit(1).query).toBe(`?value=${encodeURIComponent("sk-hbr-new-secret-value")}`);

    const addAudit = await lastAudit(db, "cpa.api_key.add");
    const delAudit = await lastAudit(db, "cpa.api_key.delete");
    const auditBlob = JSON.stringify([addAudit?.detail, delAudit?.detail, addAudit?.target]);
    expect(auditBlob).not.toContain("sk-hbr-new-secret-value");
  } finally {
    cleanup(fake);
  }
});

test("auth-file enable/disable, fields, refresh, delete: allowlisted shapes only", async () => {
  const { app, cookie, fake } = await adminSetup();
  try {
    const status = await req(app, "/api/v1/admin/cpa/auth-files/status", {
      method: "PATCH",
      cookie,
      body: { name: "user@gmail.com.json", disabled: true },
    });
    expect(status.status).toBe(200);
    expect(fake.hit(0)).toMatchObject({
      method: "PATCH",
      path: "/v0/management/auth-files/status",
    });
    expect(JSON.parse(fake.hit(0).body ?? "{}")).toEqual({
      name: "user@gmail.com.json",
      auth_index: undefined,
      disabled: true,
    });

    const fields = await req(app, "/api/v1/admin/cpa/auth-files/fields", {
      method: "PATCH",
      cookie,
      body: { name: "user@gmail.com.json", fields: { project_id: "p1", proxy_url: "http://p:1" } },
    });
    expect(fields.status).toBe(200);
    expect(fake.hit(1).path).toBe("/v0/management/auth-files/fields");
    expect(JSON.parse(fake.hit(1).body ?? "{}")).toEqual({
      name: "user@gmail.com.json",
      project_id: "p1",
      proxy_url: "http://p:1",
    });

    const refresh = await req(app, "/api/v1/admin/cpa/auth-files/refresh", {
      method: "POST",
      cookie,
    });
    expect(refresh.status).toBe(200);
    expect(fake.hit(2)).toMatchObject({
      method: "POST",
      path: "/v0/management/auth-files/refresh",
    });

    const del = await req(app, "/api/v1/admin/cpa/auth-files", {
      method: "DELETE",
      cookie,
      body: { names: ["a.json", "b.json"], confirm: true },
    });
    expect(del.status).toBe(200);
    expect(fake.hit(3)).toMatchObject({ method: "DELETE", path: "/v0/management/auth-files" });
    expect(JSON.parse(fake.hit(3).body ?? "{}")).toEqual({ names: ["a.json", "b.json"] });
    // Never the destructive ?all= variant.
    expect(fake.hits.every((h) => !h.query.includes("all"))).toBe(true);
  } finally {
    cleanup(fake);
  }
});

test("routing strategy and model mapping controls forward allowlisted bodies", async () => {
  const { app, cookie, fake } = await adminSetup();
  try {
    const bad = await req(app, "/api/v1/admin/cpa/routing/strategy", {
      method: "PUT",
      cookie,
      body: { strategy: "random" },
    });
    expect(bad.status).toBe(400);
    expect(fake.hits.length).toBe(0);

    const strat = await req(app, "/api/v1/admin/cpa/routing/strategy", {
      method: "PUT",
      cookie,
      body: { strategy: "fill-first" },
    });
    expect(strat.status).toBe(200);
    expect(fake.hit(0)).toMatchObject({ method: "PUT", path: "/v0/management/routing/strategy" });
    expect(JSON.parse(fake.hit(0).body ?? "{}")).toEqual({ value: "fill-first" });

    const alias = await req(app, "/api/v1/admin/cpa/model-alias", {
      method: "PUT",
      cookie,
      body: {
        channel: "claude",
        aliases: [
          { name: "claude-x", alias: "pub-name", display_name: "Public", force_mapping: true },
        ],
      },
    });
    expect(alias.status).toBe(200);
    expect(fake.hit(1).path).toBe("/v0/management/oauth-model-alias");
    expect(JSON.parse(fake.hit(1).body ?? "{}")).toEqual({
      channel: "claude",
      aliases: [
        { name: "claude-x", alias: "pub-name", "display-name": "Public", "force-mapping": true },
      ],
    });

    // Empty alias list clears the channel mapping (documented CPA semantics).
    const clear = await req(app, "/api/v1/admin/cpa/model-alias", {
      method: "PUT",
      cookie,
      body: { channel: "claude", aliases: [] },
    });
    expect(clear.status).toBe(200);
    expect(JSON.parse(fake.hit(2).body ?? "{}")).toEqual({ channel: "claude", aliases: [] });

    const excl = await req(app, "/api/v1/admin/cpa/model-exclusions", {
      method: "PUT",
      cookie,
      body: { channel: "codex", models: ["gpt-internal-1"] },
    });
    expect(excl.status).toBe(200);
    expect(fake.hit(3).path).toBe("/v0/management/oauth-excluded-models");
    expect(JSON.parse(fake.hit(3).body ?? "{}")).toEqual({
      provider: "codex",
      models: ["gpt-internal-1"],
    });
  } finally {
    cleanup(fake);
  }
});

test("upstream success bodies are never proxied; error statuses are preserved", async () => {
  const { app, cookie, fake } = await adminSetup();
  try {
    // Success body contains a marker that must not leak.
    const ok = await req(app, "/api/v1/admin/cpa/routing/strategy", {
      method: "PUT",
      cookie,
      body: { strategy: "round-robin" },
    });
    expect(ok.status).toBe(200);
    const okText = await ok.text();
    expect(okText).not.toContain("upstream-secret-never-proxied");
    expect(JSON.parse(okText)).toEqual({ ok: true });

    // Auth failure at CPA: 401 preserved with CPA_AUTH_FAILED.
    const authFake = fakeCpa({ status: 401 });
    process.env.CPA_BASE_URL = authFake.base;
    try {
      const authRes = await req(app, "/api/v1/admin/cpa/routing/strategy", {
        method: "PUT",
        cookie,
        body: { strategy: "round-robin" },
      });
      expect(authRes.status).toBe(401);
      expect((await authRes.json()).error?.code).toBe("CPA_AUTH_FAILED");
    } finally {
      authFake.stop();
      process.env.CPA_BASE_URL = fake.base;
    }

    // Application error (e.g. 400 invalid body): status preserved, CPA's own
    // message surfaced, code CPA_UPSTREAM_ERROR.
    const errFake = fakeCpa({ status: 400 });
    process.env.CPA_BASE_URL = errFake.base;
    try {
      const errRes = await req(app, "/api/v1/admin/cpa/routing/strategy", {
        method: "PUT",
        cookie,
        body: { strategy: "round-robin" },
      });
      expect(errRes.status).toBe(400);
      const errBody = await errRes.json();
      expect(errBody.error?.code).toBe("CPA_UPSTREAM_ERROR");
      expect(errBody.error?.message).toBe("upstream said no");
    } finally {
      errFake.stop();
    }
  } finally {
    cleanup(fake);
  }
});
