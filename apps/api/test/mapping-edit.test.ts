// One editable route per model: PUT route endpoint, no-op on same value,
// POST never leaves two enabled mappings, non-admin 403.
import { describe, expect, test } from "bun:test";
import { makeApp, signUp, req, makeInstanceAdmin, userIdByEmail, q } from "./helpers";

async function setup() {
  const { db, app } = await makeApp();
  const cookie = await signUp(app, "mapedit@example.com");
  await makeInstanceAdmin(db, await userIdByEmail(db, "mapedit@example.com"));
  const created = await req(app, "/api/v1/admin/catalog/models", {
    method: "POST",
    cookie,
    body: {
      public_id: "hoborouter/route-test",
      slug: "route-test",
      display_name: "Route Test",
      provider: "z-ai",
      enabled: true,
      published: true,
    },
  });
  expect(created.status).toBe(201);
  const { id: modelId } = (await created.json()) as { id: string };
  return { db, app, cookie, modelId };
}

describe("admin route editing", () => {
  test("PUT changes the route and disables the old mapping (history preserved)", async () => {
    const { db, app, cookie, modelId } = await setup();
    const first = await req(app, `/api/v1/admin/catalog/models/${modelId}/route`, {
      method: "PUT",
      cookie,
      body: { upstream_model: "z-ai/glm-5.3-flash" },
    });
    expect(first.status).toBe(200);
    const second = await req(app, `/api/v1/admin/catalog/models/${modelId}/route`, {
      method: "PUT",
      cookie,
      body: { provider: "cpa", upstream_model: "z-ai/glm-5.3-pro" },
    });
    expect(second.status).toBe(200);
    const rows = await q<{ upstream_model: string; enabled: boolean }>(
      db,
      "SELECT upstream_model, enabled FROM provider_model_mappings WHERE model_id = ? ORDER BY created_at ASC, id ASC",
      modelId,
    );
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ upstream_model: "z-ai/glm-5.3-flash", enabled: false });
    expect(rows[1]).toMatchObject({ upstream_model: "z-ai/glm-5.3-pro", enabled: true });
    const enabledCount = await q<{ n: string }>(
      db,
      "SELECT COUNT(*) AS n FROM provider_model_mappings WHERE model_id = ? AND enabled = true",
      modelId,
    );
    expect(Number(enabledCount[0]!.n)).toBe(1);
  });

  test("same-value PUT is a no-op", async () => {
    const { db, app, cookie, modelId } = await setup();
    await req(app, `/api/v1/admin/catalog/models/${modelId}/route`, {
      method: "PUT",
      cookie,
      body: { upstream_model: "z-ai/glm-5.3-flash" },
    });
    const res = await req(app, `/api/v1/admin/catalog/models/${modelId}/route`, {
      method: "PUT",
      cookie,
      body: { provider: "cpa", upstream_model: "z-ai/glm-5.3-flash" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { changed: boolean }).changed).toBe(false);
    const n = await q<{ n: string }>(
      db,
      "SELECT COUNT(*) AS n FROM provider_model_mappings WHERE model_id = ?",
      modelId,
    );
    expect(Number(n[0]!.n)).toBe(1);
  });

  test("POST mappings no longer leaves two enabled", async () => {
    const { db, app, cookie, modelId } = await setup();
    await req(app, `/api/v1/admin/catalog/models/${modelId}/mappings`, {
      method: "POST",
      cookie,
      body: { upstream_model: "z-ai/glm-5.3-flash" },
    });
    await req(app, `/api/v1/admin/catalog/models/${modelId}/mappings`, {
      method: "POST",
      cookie,
      body: { upstream_model: "z-ai/glm-5.3-pro" },
    });
    const n = await q<{ n: string }>(
      db,
      "SELECT COUNT(*) AS n FROM provider_model_mappings WHERE model_id = ? AND enabled = true",
      modelId,
    );
    expect(Number(n[0]!.n)).toBe(1);
  });

  test("non-admin gets 403", async () => {
    const { app, cookie, modelId } = await setup();
    void cookie;
    const userCookie = await signUp(app, "plain-mapedit@example.com");
    const res = await req(app, `/api/v1/admin/catalog/models/${modelId}/route`, {
      method: "PUT",
      cookie: userCookie,
      body: { upstream_model: "x/y" },
    });
    expect(res.status).toBe(403);
  });
});
