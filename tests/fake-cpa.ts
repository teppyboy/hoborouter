// Tiny local CLIProxyAPI (CPA) stand-in for dev/E2E. No real AI providers.
// Env: PORT (default 8399), CPA_ACCESS_KEY (bearer for /v1/*),
// CPA_MANAGEMENT_KEY (bearer for /v0/management/*).
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
  const stream = new ReadableStream({
    start(controller) {
      for (const p of parts) {
        if (p !== null) controller.enqueue(encoder.encode(p));
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

    if (path === "/v0/management/config") {
      if (bearerOf(req) !== MGMT_KEY) return json({ error: "unauthorized" }, 401);
      return json({});
    }

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
