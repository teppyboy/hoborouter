// No-upstream-leak: a stub CPA that echoes the upstream model id everywhere
// (top-level model, response.model, nested fields, error bodies, headers)
// must never leak `secret-upstream` to the client — chat JSON/SSE, responses
// JSON/SSE, CPA 400 errors, /v1/models, /api/v1/catalog/models.
import { describe, expect, test, afterAll } from "bun:test";
import { hashApiKey } from "@hoborouter/keys";
import { makeApp, signUp, req, makeInstanceAdmin, userIdByEmail, q } from "./helpers";

const PLAINTEXT = "sk-hbr-noleak-test-key";
const CPA_KEY = "test-cpa-secret";
const UPSTREAM = "z-ai/secret-upstream";
const PUBLIC = "hoborouter/auto";
const LEAK = "secret-upstream";

const fakeCpa = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path !== "/v1/chat/completions" && path !== "/v1/responses")
      return Response.json({ error: "nf" }, { status: 404 });
    const parsed = JSON.parse(await req.text()) as Record<string, unknown>;
    if (parsed.force_error === true)
      return Response.json(
        {
          error: {
            message: `Model ${UPSTREAM} rejected: bad request for ${UPSTREAM}`,
            type: "invalid_request_error",
          },
        },
        { status: 400, headers: { "x-cpa-trace-id": "t", "openai-model": UPSTREAM } },
      );
    if (parsed.stream === true) {
      const lines =
        path === "/v1/responses"
          ? [
              `data: ${JSON.stringify({
                type: "response.created",
                response: { id: "resp-1", model: UPSTREAM },
              })}\n\n`,
              `data: ${JSON.stringify({
                type: "response.completed",
                response: {
                  id: "resp-1",
                  model: UPSTREAM,
                  output: [{ type: "message", content: [{ type: "output_text", text: UPSTREAM }] }],
                },
              })}\n\ndata: [DONE]\n\n`,
            ]
          : [
              `data: ${JSON.stringify({
                id: "c1",
                object: "chat.completion.chunk",
                model: UPSTREAM,
                choices: [{ index: 0, delta: { content: UPSTREAM }, finish_reason: null }],
              })}\n\n`,
              `data: ${JSON.stringify({
                id: "c1",
                object: "chat.completion.chunk",
                model: UPSTREAM,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              })}\n\ndata: [DONE]\n\n`,
            ];
      return new Response(lines.join(""), {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "openai-model": UPSTREAM,
          "x-cpa-trace-id": "t",
        },
      });
    }
    const body =
      path === "/v1/responses"
        ? {
            id: "resp-1",
            model: UPSTREAM,
            response: { id: "resp-1", model: UPSTREAM, nested: { inner: UPSTREAM } },
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          }
        : {
            id: "c1",
            object: "chat.completion",
            model: UPSTREAM,
            choices: [
              { index: 0, message: { role: "assistant", content: UPSTREAM }, finish_reason: "stop" },
            ],
            usage: {
              prompt_tokens: 5,
              completion_tokens: 2,
              prompt_tokens_details: { cached_tokens: 0 },
              completion_tokens_details: { reasoning_tokens: 0 },
            },
          };
    return Response.json(body, {
      status: 200,
      headers: { "openai-model": UPSTREAM, "x-cpa-trace-id": "t" },
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
  const cookie = await signUp(app, "noleak@example.com");
  await makeInstanceAdmin(db, await userIdByEmail(db, "noleak@example.com"));
  const created = await req(app, "/api/v1/admin/catalog/models", {
    method: "POST",
    cookie,
    body: {
      public_id: PUBLIC,
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
  expect(
    (
      await req(app, `/api/v1/admin/catalog/models/${modelId}/mappings`, {
        method: "POST",
        cookie,
        body: { provider: "cpa", upstream_model: UPSTREAM, enabled: true },
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await req(app, `/api/v1/admin/catalog/models/${modelId}/prices`, {
        method: "POST",
        cookie,
        body: {
          input_usd_micro_per_1m: 1000000,
          output_usd_micro_per_1m: 2000000,
          cached_input_usd_micro_per_1m: 0,
          reasoning_usd_micro_per_1m: 0,
          markup_ppm: 1200000,
        },
      })
    ).status,
  ).toBe(201);

  const now = Date.now();
  await q(db, "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-nl','nl','active',?)", now);
  await q(db, "INSERT INTO workspace_members (workspace_id, user_id, role) SELECT 'ws-nl', id, 'owner' FROM users WHERE email = 'noleak@example.com'");
  await q(db, "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES ('wal-nl','ws-nl','VND',1000000000,0,0,?)", now);
  await q(db, "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-nl','ws-nl',?,?,'nl','active',?)", hashApiKey(PLAINTEXT), "sk-hbr-nl...", now);
  return { app };
}

function assertNoLeak(res: Response) {
  for (const v of res.headers.values()) expect(v).not.toContain(LEAK);
  return res.text().then((text) => {
    expect(text).not.toContain(LEAK);
    return text;
  });
}

async function post(app: Awaited<ReturnType<typeof setup>>["app"], path: string, body: object) {
  return req(app, path, {
    method: "POST",
    headers: { authorization: `Bearer ${PLAINTEXT}` },
    body,
  });
}

describe("no upstream model id leak", () => {
  test("chat JSON", async () => {
    const { app } = await setup();
    await assertNoLeak(await post(app, "/v1/chat/completions", { model: PUBLIC, messages: [] }));
  });

  test("chat SSE", async () => {
    const { app } = await setup();
    await assertNoLeak(
      await post(app, "/v1/chat/completions", { model: PUBLIC, messages: [], stream: true }),
    );
  });

  test("responses JSON (incl. response.model + nested)", async () => {
    const { app } = await setup();
    const text = await assertNoLeak(await post(app, "/v1/responses", { model: PUBLIC }));
    const o = JSON.parse(text) as { model: string; response: { model: string } };
    expect(o.model).toBe(PUBLIC);
    expect(o.response.model).toBe(PUBLIC);
  });

  test("responses SSE (incl. response.model in events)", async () => {
    const { app } = await setup();
    await assertNoLeak(await post(app, "/v1/responses", { model: PUBLIC, stream: true }));
  });

  test("CPA 400 error: sanitized, status 400, no upstream id", async () => {
    const { app } = await setup();
    const res = await post(app, "/v1/chat/completions", {
      model: PUBLIC,
      messages: [],
      force_error: true,
    });
    expect(res.status).toBe(400);
    const text = await assertNoLeak(res);
    const o = JSON.parse(text) as { error: { message: string } };
    expect(o.error.message).toContain(PUBLIC);
  });

  test("GET /v1/models and /api/v1/catalog/models: public ids only", async () => {
    const { app } = await setup();
    await assertNoLeak(
      await req(app, "/v1/models", { headers: { authorization: `Bearer ${PLAINTEXT}` } }),
    );
    const cookie = (await signUp(app, "noleak2@example.com")) as string;
    await assertNoLeak(await req(app, "/api/v1/catalog/models", { cookie }));
  });
});
