// Public model id -> upstream CPA model mapping, end to end:
// admin catalog setup (public_id `hoborouter/auto`, upstream
// `z-ai/glm-5.3-flash`), gateway outbound body + response model rewrite
// (JSON and SSE), and /v1/models listing public ids only.
import { describe, expect, test, afterAll } from "bun:test";
import type { Db } from "@hoborouter/db";
import { sql } from "drizzle-orm";
import { hashApiKey } from "@hoborouter/keys";
import { makeApp, signUp, req, makeInstanceAdmin, userIdByEmail } from "./helpers";

const PLAINTEXT = "sk-hbr-pubmap-test-key";
const CPA_KEY = "test-cpa-secret";

const captured: { body: string }[] = [];
const fakeCpa = Bun.serve({
  port: 0,
  fetch: async (req) => {
    if (new URL(req.url).pathname !== "/v1/chat/completions")
      return Response.json({ error: "nf" }, { status: 404 });
    if (req.headers.get("authorization") !== `Bearer ${CPA_KEY}`)
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const body = await req.text();
    captured.push({ body });
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed.stream === true) {
      const frame = (delta: Record<string, unknown>) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-x",
          object: "chat.completion.chunk",
          model: parsed.model,
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`;
      return new Response(
        [
          frame({ role: "assistant" }),
          frame({ content: "hi" }),
          `data: ${JSON.stringify({
            id: "chatcmpl-x",
            object: "chat.completion.chunk",
            model: parsed.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({
      id: "chatcmpl-x",
      object: "chat.completion",
      model: parsed.model,
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    });
  },
});

process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeCpa.port}`;
process.env.CPA_ACCESS_KEY = CPA_KEY;
afterAll(() => {
  fakeCpa.stop(true);
  delete process.env.CPA_BASE_URL;
  delete process.env.CPA_ACCESS_KEY;
});

async function setup() {
  const { db, app } = await makeApp();
  const cookie = await signUp(app, "pubmap@example.com");
  await makeInstanceAdmin(db, await userIdByEmail(db, "pubmap@example.com"));

  const created = await req(app, "/api/v1/admin/catalog/models", {
    method: "POST",
    cookie,
    body: {
      public_id: "hoborouter/auto",
      slug: "auto",
      display_name: "Auto",
      provider: "z-ai",
      context_window: 128000,
      enabled: true,
      published: true,
    },
  });
  expect(created.status).toBe(201);
  const { id: modelId } = (await created.json()) as { id: string };

  const mapping = await req(app, `/api/v1/admin/catalog/models/${modelId}/mappings`, {
    method: "POST",
    cookie,
    body: { provider: "cpa", upstream_model: "z-ai/glm-5.3-flash", enabled: true },
  });
  expect(mapping.status).toBe(201);

  const price = await req(app, `/api/v1/admin/catalog/models/${modelId}/prices`, {
    method: "POST",
    cookie,
    body: {
      input_usd_micro_per_1m: 1000000,
      output_usd_micro_per_1m: 2000000,
      cached_input_usd_micro_per_1m: 0,
      reasoning_usd_micro_per_1m: 0,
      markup_ppm: 1200000,
    },
  });
  expect(price.status).toBe(201);

  await seedWalletAndKey(db);
  return { app };
}

async function seedWalletAndKey(db: Db) {
  const now = Date.now();
  await db.execute(
    sql`INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-pm','pm','active',${now})`,
  );
  await db.execute(
    sql`INSERT INTO workspace_members (workspace_id, user_id, role) SELECT 'ws-pm', id, 'owner' FROM users WHERE email = 'pubmap@example.com'`,
  );
  await db.execute(
    sql`INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES ('wal-pm','ws-pm','VND',1000000000,0,0,${now})`,
  );
  await db.execute(
    sql`INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-pm','ws-pm',${hashApiKey(PLAINTEXT)},'sk-hbr-pm...','pm','active',${now})`,
  );
}

describe("public model id -> upstream mapping", () => {
  test("chat JSON: outbound model is upstream, response model is public id", async () => {
    const { app } = await setup();
    const res = await req(app, "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${PLAINTEXT}` },
      body: { model: "hoborouter/auto", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(captured[0]!.body).model).toBe("z-ai/glm-5.3-flash");
    expect(((await res.json()) as { model: string }).model).toBe("hoborouter/auto");
  });

  test("chat SSE: every chunk model is the public id, never the upstream id", async () => {
    const { app } = await setup();
    const res = await req(app, "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${PLAINTEXT}` },
      body: {
        model: "hoborouter/auto",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
    });
    if (res.status !== 200) console.log("BODY", await res.clone().text());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("z-ai/glm-5.3-flash");
    expect((text.match(/"model":"hoborouter\/auto"/g) ?? []).length).toBe(3);
  });

  test("/v1/models lists the public id only", async () => {
    const { app } = await setup();
    const res = await req(app, "/v1/models", { headers: { authorization: `Bearer ${PLAINTEXT}` } });
    if (res.status !== 200) console.log("BODY", await res.clone().text());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("hoborouter/auto");
    expect(text).not.toContain("z-ai/glm-5.3-flash");
  });
});
