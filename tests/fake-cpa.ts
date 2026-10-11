// Tiny local CLIProxyAPI (CPA) stand-in for dev/E2E. No real AI providers.
// Env: PORT (default 8399), CPA_ACCESS_KEY (bearer for /v1/*),
// CPA_MANAGEMENT_KEY (bearer for /v0/management/*).
// Management fixture: stock-shaped /v0/management responses for the isolated
// CPA panel E2E (auth files, model alias, oauth exclusions). GET /__test/state
// returns the mutable fixture state plus every management request seen, so the
// E2E can prove "confirm mutated once" and "cancel mutated zero times".
// Shapes matched to packages/usage createUsageTap: chat JSON needs
// usage.prompt_tokens/completion_tokens; chat SSE needs finish_reason "stop",
// a final usage chunk, and "data: [DONE]"; responses JSON needs
// status "completed" + usage.input_tokens/output_tokens; responses SSE needs
// a response.completed event whose response carries status + usage.

const PORT = Number(process.env.PORT ?? 8399);
const ACCESS_KEY = process.env.CPA_ACCESS_KEY ?? "";
const MGMT_KEY = process.env.CPA_MANAGEMENT_KEY ?? "";

const MODEL = "fake-model";
const PROMPT_TOKENS = 12;
const COMPLETION_TOKENS = 5;

// Mutable management fixture state (in-memory, per fake CPA process).
type AuthFile = {
  name: string;
  type: string;
  provider: string;
  disabled: boolean;
  status: string;
};
const mgmtConfig: Record<string, unknown> = {
  debug: false,
  "request-log": false,
  "logging-to-file": false,
  "force-model-prefix": false,
  "request-retry": 3,
  "max-retry-credentials": 1,
  "max-retry-interval": 5,
};
const authFiles: AuthFile[] = [
  {
    name: "qwen-oauth.json",
    type: "qwen",
    provider: "qwen",
    disabled: false,
    status: "active",
  },
  {
    name: "claude-account.json",
    type: "claude",
    provider: "claude",
    disabled: true,
    status: "disabled",
  },
  {
    name: "gemini-oauth.json",
    type: "gemini",
    provider: "gemini",
    disabled: false,
    status: "active",
  },
];
const modelAliases: Record<string, unknown> = {
  qwen: [{ name: "qwen3-max", alias: "qwen-max", "force-mapping": false }],
  gemini: [{ name: "gemini-2.5-pro", alias: "gemini-pro", fork: true }],
};
const excludedModels: Record<string, string[]> = {
  gemini: ["gemini-2.5-pro-preview-06-05"],
};
const mgmtHits: { method: string; path: string; body: unknown }[] = [];
const recordHit = (method: string, path: string, body: unknown) =>
  mgmtHits.push({ method, path, body });

const mgmtAuth = (req: Request) => bearerOf(req) === MGMT_KEY;

async function handleManagement(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  if (!mgmtAuth(req)) return json({ error: "unauthorized" }, 401);
  let body: unknown = undefined;
  if (method === "PATCH" || method === "DELETE" || method === "PUT") {
    try {
      body = await req.json();
    } catch {
      body = null;
    }
  }
  recordHit(method, path, body);

  if (method === "GET" && path === "/v0/management/config") return json(mgmtConfig);

  if (method === "GET" && path === "/v0/management/auth-files")
    return json({ files: authFiles, total: authFiles.length });

  if (method === "PATCH" && path === "/v0/management/auth-files/status") {
    const b = body as { name?: string; disabled?: boolean } | null;
    const file = authFiles.find((f) => f.name === b?.name);
    if (!file || typeof b?.disabled !== "boolean") return json({ error: "invalid" }, 400);
    file.disabled = b.disabled;
    file.status = file.disabled ? "disabled" : "active";
    return json({ ok: true });
  }

  if (method === "DELETE" && path === "/v0/management/auth-files") {
    const b = body as { names?: string[] } | null;
    const names = Array.isArray(b?.names) ? b.names : [];
    const files = names.filter((n) => authFiles.some((f) => f.name === n));
    for (const n of files) {
      const i = authFiles.findIndex((f) => f.name === n);
      authFiles.splice(i, 1);
    }
    return json({ status: "ok", deleted: files.length, files, failed: [] });
  }

  if (method === "GET" && path === "/v0/management/oauth-model-alias")
    return json({ "oauth-model-alias": modelAliases });

  if (method === "PATCH" && path === "/v0/management/oauth-model-alias") {
    const b = body as { channel?: string; aliases?: unknown } | null;
    if (!b?.channel || typeof b.channel !== "string") return json({ error: "invalid" }, 400);
    modelAliases[b.channel] = b.aliases ?? [];
    return json({ ok: true });
  }

  if (method === "GET" && path === "/v0/management/oauth-excluded-models")
    return json({ "oauth-excluded-models": excludedModels });

  if (method === "PATCH" && path === "/v0/management/oauth-excluded-models") {
    const b = body as { provider?: string; models?: string[] } | null;
    if (!b?.provider || typeof b.provider !== "string") return json({ error: "invalid" }, 400);
    excludedModels[b.provider] = Array.isArray(b.models) ? b.models : [];
    return json({ ok: true });
  }

  if (method === "DELETE" && path === "/v0/management/oauth-excluded-models") {
    const provider = url.searchParams.get("provider");
    if (!provider) return json({ error: "provider required" }, 400);
    excludedModels[provider] = [];
    return json({ ok: true });
  }

  return json({ error: "not_found", path }, 404);
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const bearerOf = (req: Request) => {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
};

const usage = () => ({
  prompt_tokens: PROMPT_TOKENS,
  completion_tokens: COMPLETION_TOKENS,
  total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0 },
  // responses-API naming (superset, harmless on chat shapes)
  input_tokens: PROMPT_TOKENS,
  output_tokens: COMPLETION_TOKENS,
  total_tokens_alt: undefined as number | undefined,
});

const responsesUsage = () => ({
  input_tokens: PROMPT_TOKENS,
  output_tokens: COMPLETION_TOKENS,
  total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
});

const chatChunk = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "chatcmpl-fake",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: typeof body.model === "string" ? body.model : MODEL,
  choices: [{ index: 0, delta: {}, finish_reason: null }],
  ...extra,
});

const sse = (parts: (string | null)[]) => {
  const encoder = new TextEncoder();
  // HBR_FAKE_CPA_CHUNK_DELAY_MS: inter-chunk delay so E2E can measure real
  // incremental delivery (default 0 = immediate).
  const delay = Number(process.env.HBR_FAKE_CPA_CHUNK_DELAY_MS) || 0;
  const stream = new ReadableStream({
    async start(controller) {
      for (const p of parts) {
        if (p !== null) controller.enqueue(encoder.encode(p));
        if (delay > 0) await Bun.sleep(delay);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
};

const readJson = async (req: Request): Promise<Record<string, unknown>> => {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
};

async function handleChat(req: Request): Promise<Response> {
  const body = await readJson(req);
  const promptText =
    Array.isArray(body.messages) && body.messages.length > 0
      ? String((body.messages[body.messages.length - 1] as Record<string, unknown>)?.content ?? "")
      : "";
  if (body.stream === true) {
    const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    return sse([
      frame(
        chatChunk(body, {
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }),
      ),
      frame(
        chatChunk(body, {
          choices: [
            {
              index: 0,
              delta: { content: `Hello from ${MODEL}: ${promptText}` },
              finish_reason: null,
            },
          ],
        }),
      ),
      frame(
        chatChunk(body, {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
      ),
      frame({
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model ?? MODEL,
        choices: [],
        usage: usage(),
      }),
      "data: [DONE]\n\n",
    ]);
  }
  return json({
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: `Hello from ${MODEL}: ${promptText}` },
        finish_reason: "stop",
      },
    ],
    usage: usage(),
  });
}

async function handleResponses(req: Request): Promise<Response> {
  const body = await readJson(req);
  const inputText = typeof body.input === "string" ? body.input : JSON.stringify(body.input ?? "");
  const completed = () => ({
    id: "resp-fake",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: body.model ?? MODEL,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `Hello from ${MODEL}: ${inputText}` }],
      },
    ],
    usage: responsesUsage(),
  });
  if (body.stream === true) {
    const frame = (obj: unknown) =>
      `event: ${String((obj as Record<string, string>).type)}\ndata: ${JSON.stringify(obj)}\n\n`;
    return sse([
      frame({ type: "response.created", response: { id: "resp-fake", status: "in_progress" } }),
      frame({ type: "response.output_text.delta", delta: `Hello from ${MODEL}` }),
      frame({ type: "response.completed", response: completed() }),
    ]);
  }
  return json(completed());
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") return json({ status: "ok" });

    if (path.startsWith("/v0/management/")) return handleManagement(req);

    if (path === "/__test/state" && mgmtAuth(req))
      return json({
        authFiles,
        modelAliases,
        excludedModels,
        hits: mgmtHits,
      });

    if (path === "/v1/models") {
      if (bearerOf(req) !== ACCESS_KEY) return json({ error: "unauthorized" }, 401);
      return json({ object: "list", data: [{ id: MODEL, object: "model", owned_by: "fake" }] });
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      if (bearerOf(req) !== ACCESS_KEY) return json({ error: "unauthorized" }, 401);
      return handleChat(req);
    }

    if (path === "/v1/responses" && req.method === "POST") {
      if (bearerOf(req) !== ACCESS_KEY) return json({ error: "unauthorized" }, 401);
      return handleResponses(req);
    }

    return json({ error: "not_found", path }, 404);
  },
});

console.log(`fake-cpa listening on :${server.port}`);
