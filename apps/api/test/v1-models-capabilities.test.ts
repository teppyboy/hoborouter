// /v1/models capability projection (parity Task 3): safe supported_parameters,
// reasoning, capabilities, context_window derived from stored catalog fields
// only. Private mapping/upstream internals must never appear, even when the
// catalog has real upstream mappings behind the public ids.
import { describe, expect, test } from "bun:test";
import type { Db } from "@hoborouter/db";
import { sql } from "drizzle-orm";
import { hashApiKey } from "@hoborouter/keys";
import { makeApp, signUp, req, makeInstanceAdmin, userIdByEmail } from "./helpers";

const PLAINTEXT = "sk-hbr-caps-test-key";
const UPSTREAM = "secret-upstream/glm-x";

async function seedModel(
  db: Db,
  o: {
    id: string;
    publicId: string;
    caps: string[] | null;
    contextWindow: number | null;
  },
) {
  const now = Date.now();
  await db.execute(
    sql`INSERT INTO models (id, public_id, slug, display_name, provider, capabilities, context_window, enabled, published, created_at, updated_at) VALUES (${o.id}, ${o.publicId}, ${o.id + "-slug"}, ${o.id}, 'z-ai', ${o.caps === null ? null : JSON.stringify(o.caps)}, ${o.contextWindow}, true, true, ${now}, ${now})`,
  );
  await db.execute(
    sql`INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES (${o.id + "-map"}, ${o.id}, 'cpa', ${UPSTREAM}, true, ${now}, ${now})`,
  );
  await db.execute(
    sql`INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES (${o.id + "-price"}, ${o.id}, 1000000, 2000000, 0, 0, 1200000, ${now - 1000}, NULL)`,
  );
}

async function setup() {
  const { db, app } = await makeApp();
  await signUp(app, "caps@example.com");
  await makeInstanceAdmin(db, await userIdByEmail(db, "caps@example.com"));
  const now = Date.now();
  await db.execute(
    sql`INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-caps','caps','active',${now})`,
  );
  await db.execute(
    sql`INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-caps','ws-caps',${hashApiKey(PLAINTEXT)},'sk-hbr-caps...','caps','active',${now})`,
  );
  await seedModel(db, {
    id: "mdl-full",
    publicId: "test-full",
    caps: ["chat", "tools", "reasoning"],
    contextWindow: 128000,
  });
  await seedModel(db, {
    id: "mdl-plain",
    publicId: "test-plain",
    caps: null,
    contextWindow: null,
  });
  return { db, app };
}

const bearer = { authorization: `Bearer ${PLAINTEXT}` };

type ModelEntry = {
  id: string;
  object: string;
  supported_parameters?: string[];
  reasoning?: boolean;
  capabilities?: string[];
  context_window?: number;
};

describe("GET /v1/models capability projection", () => {
  test("requires a valid Bearer key", async () => {
    const { app } = await setup();
    expect((await req(app, "/v1/models")).status).toBe(401);
    expect(
      (await req(app, "/v1/models/test-full", { headers: { authorization: "Bearer nope" } }))
        .status,
    ).toBe(401);
  });

  test("list: capability fields derived from stored catalog values", async () => {
    const { app } = await setup();
    const res = await req(app, "/v1/models", { headers: bearer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: ModelEntry[] };
    expect(body.object).toBe("list");
    const full = body.data.find((m) => m.id === "test-full")!;
    expect(full.supported_parameters).toEqual(["stream", "tools", "reasoning"]);
    expect(full.reasoning).toBe(true);
    expect(full.capabilities).toEqual(["chat", "tools", "reasoning"]);
    expect(full.context_window).toBe(128000);

    const plain = body.data.find((m) => m.id === "test-plain")!;
    expect(plain.supported_parameters).toEqual(["stream"]);
    expect(plain.reasoning).toBe(false);
    // Null stored capabilities are undeclared, projected as [] — never inferred.
    expect(plain.capabilities).toEqual([]);
    // Unknown context window: the key is absent, not fabricated.
    expect("context_window" in plain).toBe(false);
  });

  test("detail: same projection per public id", async () => {
    const { app } = await setup();
    const res = await req(app, "/v1/models/test-full", { headers: bearer });
    expect(res.status).toBe(200);
    const m = (await res.json()) as ModelEntry;
    expect(m.id).toBe("test-full");
    expect(m.supported_parameters).toEqual(["stream", "tools", "reasoning"]);
    expect(m.reasoning).toBe(true);
    expect(m.context_window).toBe(128000);
    expect((await req(app, "/v1/models/test/missing", { headers: bearer })).status).toBe(404);
  });

  test("no private mapping/upstream/reasoning-route fields leak", async () => {
    const { app } = await setup();
    const res = await req(app, "/v1/models", { headers: bearer });
    const detail = await req(app, "/v1/models/test-full", { headers: bearer });
    const text = JSON.stringify([await res.json(), await detail.json()]);
    expect(text).not.toContain(UPSTREAM);
    expect(text).not.toContain("upstream_model");
    expect(text).not.toContain("mdl-full-map");
    expect(text).not.toContain("public_effort");
    expect(text).not.toContain("upstream_effort");
  });
});
