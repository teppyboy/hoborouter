// Auto-eligibility admin surface (BMC slice A): the catalog model
// create/update routes accept only boolean auto_eligible, persist it inside
// the same transaction as the audit row, expose it on the admin list, and
// stay instance-admin only (workspace members get 403).
import { beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "@hoborouter/db";
import {
  makeApp,
  signUp,
  req,
  makeInstanceAdmin,
  userIdByEmail,
  q,
  createWorkspace,
} from "./helpers";

type App = Awaited<ReturnType<typeof makeApp>>["app"];

// One shared app for the file: makeApp creates + migrates a throwaway
// database, which costs seconds — too slow per test.
let db: Db;
let app: App;
let adminCookie: string;
let memberCookie: string;

const baseModelBody = (publicId: string) => ({
  public_id: publicId,
  slug: publicId,
  display_name: "Auto Test " + publicId,
  provider: "z-ai",
  enabled: true,
  published: true,
});

const createModel = (cookie: string, body: Record<string, unknown>) =>
  req(app, "/api/v1/admin/catalog/models", { method: "POST", cookie, body });

const updateModel = (id: string, cookie: string, body: Record<string, unknown>) =>
  req(app, `/api/v1/admin/catalog/models/${id}`, { method: "PUT", cookie, body });

async function latestAudit(action: string, target: string) {
  const rows = await q<{ detail: string }>(
    db,
    "SELECT detail FROM audit_log WHERE action = ? AND target = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    action,
    target,
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  const ctx = await makeApp();
  db = ctx.db;
  app = ctx.app;
  const adminEmail = `aa-admin-${crypto.randomUUID().slice(0, 8)}@example.com`;
  adminCookie = await signUp(app, adminEmail);
  await makeInstanceAdmin(db, await userIdByEmail(db, adminEmail));
  // Member: has their own workspace but no instance-admin row;
  // requireInstanceAdmin must reject catalog mutations regardless of role.
  const memberEmail = `aa-member-${crypto.randomUUID().slice(0, 8)}@example.com`;
  memberCookie = await signUp(app, memberEmail);
  await createWorkspace(db, "ws-auto-admin-member", await userIdByEmail(db, memberEmail));
});

describe("auto_eligible admin CRUD", () => {
  test("create persists auto_eligible and audits it in the same transaction", async () => {
    const res = await createModel(adminCookie, {
      ...baseModelBody("aa-create-on"),
      auto_eligible: true,
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const rows = await q<{ auto_eligible: boolean }>(
      db,
      "SELECT auto_eligible FROM models WHERE id = ?",
      id,
    );
    expect(rows[0]!.auto_eligible).toBe(true);
    const audit = await latestAudit("catalog.model.create", id);
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.detail).auto_eligible).toBe(true);
  });

  test("create without auto_eligible defaults to false", async () => {
    const res = await createModel(adminCookie, baseModelBody("aa-create-default"));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const rows = await q<{ auto_eligible: boolean }>(
      db,
      "SELECT auto_eligible FROM models WHERE id = ?",
      id,
    );
    expect(rows[0]!.auto_eligible).toBe(false);
  });

  test("update flips the persisted boolean and audits each transition", async () => {
    const created = await createModel(adminCookie, baseModelBody("aa-update-toggle"));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const before = await q<{ auto_eligible: boolean }>(
      db,
      "SELECT auto_eligible FROM models WHERE id = ?",
      id,
    );
    expect(before[0]!.auto_eligible).toBe(false);

    const on = await updateModel(id, adminCookie, { auto_eligible: true });
    expect(on.status).toBe(200);
    const after = await q<{ auto_eligible: boolean }>(
      db,
      "SELECT auto_eligible FROM models WHERE id = ?",
      id,
    );
    expect(after[0]!.auto_eligible).toBe(true);
    const onAudit = await latestAudit("catalog.model.update", id);
    expect(onAudit).not.toBeNull();
    expect(JSON.parse(onAudit!.detail).auto_eligible).toBe(true);

    const off = await updateModel(id, adminCookie, { auto_eligible: false });
    expect(off.status).toBe(200);
    const final = await q<{ auto_eligible: boolean }>(
      db,
      "SELECT auto_eligible FROM models WHERE id = ?",
      id,
    );
    expect(final[0]!.auto_eligible).toBe(false);
    const offAudit = await latestAudit("catalog.model.update", id);
    expect(JSON.parse(offAudit!.detail).auto_eligible).toBe(false);
  });

  test("invalid auto_eligible values are rejected on create and update", async () => {
    for (const bad of ["yes", 1]) {
      const created = await createModel(adminCookie, {
        ...baseModelBody("aa-bad-" + String(bad)),
        auto_eligible: bad,
      });
      expect(created.status).toBe(400);
      const err = (await created.json()) as { error: { code: string } };
      expect(err.error.code).toBe("INVALID");
    }
    const created = await createModel(adminCookie, baseModelBody("aa-bad-update"));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    for (const bad of ["true", 0]) {
      const updated = await updateModel(id, adminCookie, { auto_eligible: bad });
      expect(updated.status).toBe(400);
    }
    // Rejected updates must not have touched the persisted value.
    const rows = await q<{ auto_eligible: boolean }>(
      db,
      "SELECT auto_eligible FROM models WHERE id = ?",
      id,
    );
    expect(rows[0]!.auto_eligible).toBe(false);
  });

  test("member (non-instance-admin) gets 403 on create and update", async () => {
    const memberCreate = await createModel(memberCookie, {
      ...baseModelBody("aa-member"),
      auto_eligible: true,
    });
    expect(memberCreate.status).toBe(403);

    const seeded = await createModel(adminCookie, {
      ...baseModelBody("aa-member-seed"),
      auto_eligible: false,
    });
    expect(seeded.status).toBe(201);
    const { id } = (await seeded.json()) as { id: string };
    const memberUpdate = await updateModel(id, memberCookie, { auto_eligible: true });
    expect(memberUpdate.status).toBe(403);
  });

  test("admin list exposes auto_eligible as a boolean", async () => {
    const on = await createModel(adminCookie, {
      ...baseModelBody("aa-list-on"),
      auto_eligible: true,
    });
    const off = await createModel(adminCookie, baseModelBody("aa-list-off"));
    expect(on.status).toBe(201);
    expect(off.status).toBe(201);
    const list = await req(app, "/api/v1/admin/catalog/models", {
      method: "GET",
      cookie: adminCookie,
    });
    expect(list.status).toBe(200);
    const rows = (await list.json()) as { public_id: string; auto_eligible: boolean }[];
    expect(rows.find((r) => r.public_id === "aa-list-on")?.auto_eligible).toBe(true);
    expect(rows.find((r) => r.public_id === "aa-list-off")?.auto_eligible).toBe(false);
  });
});
