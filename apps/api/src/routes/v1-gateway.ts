// Paid gateway routes: POST /v1/chat/completions and /v1/responses.
// Disabled by default (HBR_GATEWAY_ENABLED=1 to enable). Auth via sk-hbr-
// keys, bounded cap reservation in the wallet, markDispatching committed
// before exactly one CPA fetch, settlement exactly once via the billing
// service. Input token bound: 1 token per JSON body byte (a conservative
// upper bound — no tokenizer can exceed it), capped by context_window.
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { verifyApiKey, isModelAllowed } from "@hoborouter/keys";
import { resolveModel } from "@hoborouter/catalog";
import {
  estimateCapVnd,
  reserveRequest,
  markDispatching,
  releaseRequest,
  settleRequest,
  WalletError,
} from "@hoborouter/wallet";
import { injectChatUsageOption, createUsageTap, resolveBillableUsage } from "@hoborouter/usage";
import { jsonError } from "../authz";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB inbound JSON body limit

const openAiError = (status: number, message: string, code: string) =>
  new Response(JSON.stringify({ error: { message, type: "invalid_request_error", code } }), {
    status,
    headers: { "content-type": "application/json" },
  });

const intEnv = (name: string, fallback: number) => {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

/** Settle exactly once per request; wraps the billing service. */
function settle(
  db: Database,
  requestId: string,
  outcome:
    | { kind: "usage"; usage: import("@hoborouter/wallet").UsageTokens }
    | {
        kind: "full_hold";
        reason: "client_abort" | "upstream_error" | "unknown";
        metadata?: unknown;
      },
  done: { settled: boolean },
) {
  if (done.settled) return;
  done.settled = true;
  try {
    settleRequest(db, requestId, outcome as never, Date.now());
  } catch (err) {
    // A concurrent/repeat settlement is fine; anything else is a billing bug.
    if (!(err instanceof WalletError)) throw err;
  }
}

function settleFromTap(
  db: Database,
  requestId: string,
  result: ReturnType<ReturnType<typeof createUsageTap>["end"]>,
  rates: { input: bigint; output: bigint; cachedInput: bigint; reasoning: bigint },
  meta: { upstreamModel: string; provider: string; publicModel: string },
  done: { settled: boolean },
) {
  const billable = resolveBillableUsage(result, rates);
  if (billable.billable) {
    settle(
      db,
      requestId,
      {
        kind: "usage",
        usage: billable.usage,
        upstreamModel: meta.upstreamModel,
        provider: meta.provider,
        publicModel: meta.publicModel,
      } as never,
      done,
    );
  } else {
    settle(
      db,
      requestId,
      { kind: "full_hold", reason: "unknown", metadata: { reason: billable.reason } },
      done,
    );
  }
}

function gatewayHandler(db: Database, path: string, protocol: "chat" | "responses") {
  return async ({ request }: { request: Request }): Promise<Response> => {
    // 1. Disabled gate before any DB write.
    if (process.env.HBR_GATEWAY_ENABLED !== "1") {
      return jsonError(503, "gateway_disabled", "Paid gateway is disabled");
    }

    // 2. Auth.
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const key = token ? verifyApiKey(db, token) : null;
    if (!key) return openAiError(401, "Invalid API key provided.", "invalid_api_key");
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), key.api_key_id);

    // 3. Body validation.
    const raw = await request.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      return jsonError(413, "payload_too_large", "Request body exceeds 1 MiB");
    }
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return jsonError(400, "INVALID", "Body must be a JSON object");
    }
    if (typeof body.model !== "string" || body.model === "") {
      return jsonError(400, "INVALID", "'model' is required");
    }
    const resolved = resolveModel(db, body.model);
    if (!resolved) return jsonError(404, "model_not_found", `Model '${body.model}' not found`);
    const { model, mapping, price } = resolved;
    if (!isModelAllowed(db, key.api_key_id, model.id)) {
      return jsonError(403, "FORBIDDEN", "Model not allowed for this API key");
    }

    // 4. Bounds + cap.
    const contextWindow = model.context_window;
    if (contextWindow === null) {
      return jsonError(400, "model_missing_context_window", "Model has no context window bound");
    }
    const requestedMax =
      (body.max_tokens as number | undefined) ??
      (body.max_completion_tokens as number | undefined) ??
      (body.max_output_tokens as number | undefined);
    if (
      requestedMax !== undefined &&
      (typeof requestedMax !== "number" || !Number.isSafeInteger(requestedMax) || requestedMax < 1)
    ) {
      return jsonError(400, "INVALID", "max output tokens must be a positive integer");
    }
    let maxOutput = requestedMax;
    if (maxOutput === undefined || maxOutput > contextWindow) {
      maxOutput = Math.min(intEnv("HBR_DEFAULT_MAX_OUTPUT_TOKENS", 4096), contextWindow);
    }
    // 1 token per byte is a safe upper bound for any tokenizer.
    const maxInput = Math.min(Math.ceil(Buffer.byteLength(raw)), contextWindow);
    const fxRate = intEnv("HBR_USD_VND_RATE", 26000);
    const accessKey = process.env.CPA_ACCESS_KEY;
    if (!accessKey) return jsonError(503, "cpa_unconfigured", "CPA access key not configured");
    let capVnd: number;
    try {
      capVnd = estimateCapVnd(
        { maxInputTokens: Math.max(maxInput, 1), maxOutputTokens: Math.max(maxOutput, 1) },
        {
          inputUsdMicroPer1m: price.input_usd_micro_per_1m,
          outputUsdMicroPer1m: price.output_usd_micro_per_1m,
          cachedInputUsdMicroPer1m: price.cached_input_usd_micro_per_1m,
          reasoningUsdMicroPer1m: price.reasoning_usd_micro_per_1m,
        },
        fxRate,
        price.markup_ppm,
      );
    } catch (err) {
      if (err instanceof WalletError) return jsonError(400, "INVALID", err.message);
      throw err;
    }

    // 5. Reserve -> markDispatching (committed) -> exactly one fetch.
    const requestId = crypto.randomUUID();
    const stream = body.stream === true;
    try {
      reserveRequest(db, {
        requestId,
        workspaceId: key.workspace_id,
        apiKeyId: key.api_key_id,
        modelId: model.id,
        mappingId: mapping.id,
        modelPriceId: price.id,
        endpoint: path as "/v1/chat/completions" | "/v1/responses",
        mode: stream ? "stream" : "non-stream",
        fxRate,
        capVnd,
        now: Date.now(),
      });
    } catch (err) {
      if (err instanceof WalletError && err.code === "insufficient") {
        return jsonError(402, "insufficient_balance", "Insufficient wallet balance");
      }
      throw err;
    }

    const done = { settled: false };
    const releaseOrFail = (err: unknown): Response => {
      try {
        releaseRequest(db, requestId, Date.now());
      } catch {
        // dispatching already? markDispatching happens right after; safe to ignore here.
      }
      void err;
      return jsonError(400, "INVALID", "Request could not be prepared");
    };

    try {
      markDispatching(db, requestId, Date.now());
    } catch (err) {
      return releaseOrFail(err);
    }

    const outbound: Record<string, unknown> = { ...body, model: mapping.upstream_model };
    if (protocol === "chat") {
      delete outbound.max_completion_tokens;
      delete outbound.max_output_tokens;
      outbound.max_tokens = maxOutput;
      if (stream)
        outbound.stream_options = (
          injectChatUsageOption(outbound) as Record<string, unknown>
        ).stream_options;
    } else {
      delete outbound.max_tokens;
      delete outbound.max_completion_tokens;
      outbound.max_output_tokens = maxOutput;
    }

    const controller = new AbortController();
    const base = (process.env.CPA_BASE_URL || "http://cpa:8317").replace(/\/$/, "");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      // Inbound authorization/cookie/x-forwarded-*/x-request-id are never forwarded.
      authorization: `Bearer ${accessKey}`,
    };
    let upstream: Response;
    try {
      upstream = await fetch(base + path, {
        method: "POST",
        headers,
        body: JSON.stringify(outbound),
        signal: controller.signal,
      });
    } catch {
      if (request.signal.aborted) {
        settle(db, requestId, { kind: "full_hold", reason: "client_abort" }, done);
        return jsonError(499, "client_abort", "Client aborted the request");
      }
      settle(db, requestId, { kind: "full_hold", reason: "upstream_error" }, done);
      return jsonError(502, "upstream_error", "Upstream dispatch failed");
    }

    const traceId = upstream.headers.get("x-cpa-trace-id");
    if (traceId)
      db.prepare("UPDATE requests SET cpa_trace_id = ? WHERE id = ?").run(traceId, requestId);

    const rates = {
      input: BigInt(price.input_usd_micro_per_1m),
      output: BigInt(price.output_usd_micro_per_1m),
      cachedInput: BigInt(price.cached_input_usd_micro_per_1m),
      reasoning: BigInt(price.reasoning_usd_micro_per_1m),
    };
    const meta = {
      upstreamModel: mapping.upstream_model,
      provider: model.provider,
      publicModel: model.public_id,
    };

    // 6. Response pass-through + settlement.
    if (!upstream.ok) {
      const text = await upstream.text();
      settle(db, requestId, { kind: "full_hold", reason: "upstream_error" }, done);
      return new Response(text, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
          "x-hbr-request-id": requestId,
        },
      });
    }

    const tap = createUsageTap({ protocol, stream });
    if (!stream) {
      let ab: ArrayBuffer;
      try {
        ab = await upstream.arrayBuffer();
      } catch {
        // Body read failure (incl. client abort) must not leave 'dispatching'.
        if (request.signal.aborted) {
          tap.abort("client_abort");
          settle(db, requestId, { kind: "full_hold", reason: "client_abort" }, done);
        } else {
          settle(db, requestId, { kind: "full_hold", reason: "upstream_error" }, done);
        }
        return jsonError(502, "upstream_error", "Upstream body read failed");
      }
      const buf = new Uint8Array(ab);
      tap.push(buf);
      const result = tap.end();
      settleFromTap(db, requestId, result, rates, meta, done);
      return new Response(ab, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
          "x-hbr-request-id": requestId,
        },
      });
    }

    // Stream: pass bytes through unbuffered, feed the tap, settle on flush.
    const source = upstream.body;
    if (!source) {
      settle(db, requestId, { kind: "full_hold", reason: "upstream_error" }, done);
      return jsonError(502, "upstream_error", "Upstream returned no body");
    }
    // Pull-based passthrough: client cancel() triggers cancel() below.
    const reader = source.getReader();
    let streamedSettle = false;
    const settleStreamEnd = () => {
      if (streamedSettle) return;
      streamedSettle = true;
      settleFromTap(db, requestId, tap.end(), rates, meta, done);
    };
    const passthrough = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done: upstreamDone, value } = await reader.read();
          if (upstreamDone) {
            controller.close();
            settleStreamEnd();
            return;
          }
          tap.push(value);
          controller.enqueue(value);
        } catch (err) {
          if (!done.settled && !streamedSettle) {
            streamedSettle = true;
            if (request.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
              tap.abort("client_abort");
              settle(db, requestId, { kind: "full_hold", reason: "client_abort" }, done);
            } else {
              settle(db, requestId, { kind: "full_hold", reason: "upstream_error" }, done);
            }
          }
          controller.error(err instanceof Error ? err : new Error("stream error"));
        }
      },
      cancel() {
        controller.abort();
        void reader.cancel().catch(() => {});
        if (!done.settled && !streamedSettle) {
          streamedSettle = true;
          tap.abort("client_abort");
          settle(db, requestId, { kind: "full_hold", reason: "client_abort" }, done);
        }
      },
    });
    request.signal.addEventListener("abort", () => controller.abort(), { once: true });
    return new Response(passthrough, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        "x-hbr-request-id": requestId,
      },
    });
  };
}

export const gatewayRoutes = (db: Database) =>
  new Elysia({ name: "v1-gateway" })
    .post(
      "/v1/chat/completions",
      { detail: { hide: true } },
      gatewayHandler(db, "/v1/chat/completions", "chat"),
    ) // hidden: paid proxy stays out of /openapi.json
    .post(
      "/v1/responses",
      { detail: { hide: true } },
      gatewayHandler(db, "/v1/responses", "responses"),
    );
