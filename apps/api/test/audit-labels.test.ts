// Audit route: server-resolved actor/target labels, scoping, filters.
import { describe, expect, test } from "bun:test";
import { makeApp, signUp, req, createWorkspace, makeInstanceAdmin, userIdByEmail } from "./helpers";
import { writeAudit } from "../src/authz";

async function seed() {
  const { db, app } = await makeApp();
  const adminCookie = await signUp(app, "admin@test.dev", "Admin User");
  const adminId = userIdByEmail(db, "admin@test.dev");
  makeInstanceAdmin(db, adminId);
  createWorkspace(db, "ws1", adminId, "Test Workspace");

  // api_keys / payments / models rows referenced by audit targets.
  db.prepare(
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key1','ws1','h','hr_abcd','My Key','active',?)",
  ).run(Date.now());
  db.prepare(
    "INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES ('pay1','ws1',500000,'pending','mock','ORD1',?)",
  ).run(Date.now());
  db.prepare(
    "INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at) VALUES ('model1','anthropic/claude-x','claude-x','Claude X','anthropic',1,1,?,?)",
  ).run(Date.now(), Date.now());

  writeAudit(db, {
    actorUserId: adminId,
    workspaceId: "ws1",
    action: "workspace.create",
    target: "ws1",
  });
  writeAudit(db, {
    actorUserId: adminId,
    workspaceId: "ws1",
    action: "key.create",
    target: "key1",
    detail: { name: "My Key", key_prefix: "hr_abcd" },
  });
  writeAudit(db, {
    actorUserId: adminId,
    workspaceId: "ws1",
    action: "payment.create",
    target: "pay1",
    detail: { amount: 500000, provider: "mock" },
  });
  writeAudit(db, {
    actorUserId: adminId,
    workspaceId: null,
    action: "catalog.model.create",
    target: "model1",
    detail: { public_id: "anthropic/claude-x", slug: "claude-x", provider: "anthropic" },
  });
  return { db, app, adminCookie };
}

describe("GET /api/v1/audit", () => {
  test("resolves actor name/email and target labels", async () => {
    const { app, adminCookie } = await seed();
    const res = await req(app, "/api/v1/audit", { cookie: adminCookie });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    const byAction = new Map(rows.map((r) => [r.action as string, r]));

    const ws = byAction.get("workspace.create")!;
    expect(ws.actor).toEqual({
      id: ws.actor_user_id,
      name: "Admin User",
      email: "admin@test.dev",
    });
    expect(ws.target_label).toBe("Test Workspace");
    expect(ws.target_type).toBe("workspace");

    const key = byAction.get("key.create")!;
    expect(key.target_label).toBe("My Key");
    expect(key.target_type).toBe("api key");
    // Never plaintext/hash — prefix only.
    expect(key.target_meta).toMatchObject({ prefix: "hr_abcd" });

    const pay = byAction.get("payment.create")!;
    expect(pay.target_label).toBe("500.000 ₫ mock top-up");
    expect(pay.target_type).toBe("payment");

    const model = byAction.get("catalog.model.create")!;
    expect(model.target_label).toBe("anthropic/claude-x");
    expect(model.target_type).toBe("model");
  });

  test("redacts secret-looking detail fields", async () => {
    const { db, app, adminCookie } = await seed();
    writeAudit(db, {
      actorUserId: userIdByEmail(db, "admin@test.dev"),
      workspaceId: "ws1",
      action: "key.create",
      target: "key1",
      detail: { name: "k", key_hash: "deadbeef", provider_secret: "sk-123" },
    });
    const res = await req(app, "/api/v1/audit?action=key.create", { cookie: adminCookie });
    const rows = (await res.json()) as Array<{ detail: string }>;
    const withSecret = rows.find((r) => r.detail?.includes("redacted"))!;
    expect(withSecret).toBeDefined();
    expect(withSecret.detail).toContain("[redacted]");
    expect(withSecret.detail).not.toContain("deadbeef");
    expect(withSecret.detail).not.toContain("sk-123");
  });

  test("action prefix filter and limit", async () => {
    const { app, adminCookie } = await seed();
    const res = await req(app, "/api/v1/audit?action=payment&limit=200", { cookie: adminCookie });
    const rows = (await res.json()) as Array<{ action: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe("payment.create");
  });

  test("workspace admin sees own workspace rows with labels; global needs instance admin", async () => {
    const { db, app } = await seed();
    // Second user: ws admin only.
    const wsAdminCookie = await signUp(app, "wsa@test.dev", "WS Admin");
    const wsAdminId = userIdByEmail(db, "wsa@test.dev");
    db.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws1',?, 'admin')",
    ).run(wsAdminId);

    const denied = await req(app, "/api/v1/audit", { cookie: wsAdminCookie });
    expect(denied.status).toBe(403);

    const scoped = await req(app, "/api/v1/audit?workspace_id=ws1", { cookie: wsAdminCookie });
    expect(scoped.status).toBe(200);
    const rows = (await scoped.json()) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.workspace_id).toBe("ws1");
    expect(rows[0]!.actor).toMatchObject({ name: "Admin User" });
  });
});
