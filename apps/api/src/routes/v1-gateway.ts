// Paid gateway routes: POST /v1/chat/completions and /v1/responses.
// Enabled by default (HBR_GATEWAY_ENABLED=0 to disable). Auth via sk-hbr-
// keys, bounded cap reservation in the wallet, markDispatching committed
// before exactly one CPA fetch, settlement exactly once via the billing
// service. Input token bound: 1 token per JSON body byte (a conservative
// upper bound — no tokenizer can exceed it), capped by context_window.
import { Elysia } from "elysia";
import type { Db } from "@hoborouter/db";
import { verifyApiKey, isModelAllowed } from "@hoborouter/keys";
import { AUTO_PUBLIC_ID, resolveModel } from "@hoborouter/catalog";
import { resolveAutoModel } from "../auto-resolve";
import {
  estimateCapVnd,
  reserveRequest,
  markDispatching,
  releaseRequest,
  settleRequest,
  WalletError,
} from "@hoborouter/wallet";
import { injectChatUsageOption, createUsageTap, resolveBillableUsage } from "@hoborouter/usage";
import { transitionThroughputAllowances } from "@hoborouter/payments";
import { and, eq, gt, lte } from "drizzle-orm";
import {
  apiKeys,
  requests,
  instanceSettings,
  subscriptionPlans,
  subscriptions,
  throughputAllowances,
} from "@hoborouter/db";
import { jsonError } from "../authz";
import {
  checkSubscriptionRateLimit,
  checkThroughputAllowanceLimit,
  rateLimitNow,
  uncountSubscriptionRateLimit,
  uncountThroughputAllowanceLimit,
} from "../rate-limit";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB inbound JSON body limit
const CHAT_MAX_BODY_BYTES = 16 * 1024 * 1024; // chat-purpose key on /v1/chat/completions: 10 MiB raw attachments x 4/3 base64 + JSON headroom

export { MAX_BODY_BYTES, CHAT_MAX_BODY_BYTES };

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

/**
 * Effective prompt caching for a model: explicit per-model override wins,
 * otherwise the global instance_settings.prompt_caching_enabled flag
 * (default true when unset). Requests are IDENTICAL either way — this only
 * affects billing (OFF bills cached tokens at the full input rate).
 */
async function effectiveCachingOn(db: Db, promptCaching: string): Promise<boolean> {
  if (promptCaching === "on") return true;
  if (promptCaching === "off") return false;
  const rows = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, "prompt_caching_enabled"))
    .limit(1);
  return rows[0] ? rows[0].value === "true" : true;
}

/** Settle exactly once per request; wraps the billing service. */
async function settle(
  db: Db,
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
    await settleRequest(db, requestId, outcome as never, Date.now());
  } catch (err) {
    // A concurrent/repeat settlement is fine; anything else is a billing bug.
    if (!(err instanceof WalletError)) throw err;
  }
}

async function settleFromTap(
  db: Db,
  requestId: string,
  result: ReturnType<ReturnType<typeof createUsageTap>["end"]>,
  rates: { input: bigint; output: bigint; cachedInput: bigint; reasoning: bigint },
  meta: { upstreamModel: string; provider: string; publicModel: string },
  cachingOn: boolean,
  done: { settled: boolean },
  timing: { latencyMs?: number; ttftMs?: number },
) {
  const billable = resolveBillableUsage(result, rates);
  if (billable.billable) {
    // Caching OFF: charge all input at the full rate (cachedInputTokens = 0
    // for calculateCharge) but still STORE the provider-reported cached count.
    const chargeUsage = cachingOn ? billable.usage : { ...billable.usage, cachedInputTokens: 0n };
    const metadata: Record<string, unknown> = {
      ...(billable.assumed ? { assumed_splits: billable.assumed } : {}),
      ...(cachingOn ? {} : { caching: "off" }),
    };
    await settle(
      db,
      requestId,
      {
        kind: "usage",
        usage: chargeUsage,
        upstreamModel: meta.upstreamModel,
        provider: meta.provider,
        publicModel: meta.publicModel,
        ...(cachingOn ? {} : { storedCachedInputTokens: billable.usage.cachedInputTokens }),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...timing,
      } as never,
      done,
    );
  } else {
    await settle(
      db,
      requestId,
      {
        kind: "full_hold",
        reason: "unknown",
        metadata: { reason: billable.reason },
        publicModel: meta.publicModel,
      } as never,
      done,
    );
  }
}

/**
 * Recursively replace every occurrence of the upstream model id (and any
 * extra `from -> to` pairs, e.g. the mapping provider label) in every string
 * value of a parsed JSON value. Guarantees no upstream id reaches the client,
 * wherever it nests (top-level `model`, `response.model`, nested fields).
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function scrubJsonStrings(
  value: unknown,
  upstreamModel: string,
  publicModel: string,
  extra: readonly (readonly [string, string])[] = [],
): JsonValue {
  const scrubString = (s: string): string => {
    let out = s.split(upstreamModel).join(publicModel);
    for (const [from, to] of extra) out = out.split(from).join(to);
    return out;
  };
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value))
    return value.map((v) => scrubJsonStrings(v, upstreamModel, publicModel, extra));
  if (typeof value === "object" && value !== null) {
    const out: JsonValue = {};
    for (const [k, v] of Object.entries(value))
      out[k] = scrubJsonStrings(v, upstreamModel, publicModel, extra);
    return out;
  }
  return value as JsonValue; // number | boolean | null
}

/** Rewrite upstream model ids in a JSON response body. */
function rewriteJsonModel(
  ab: ArrayBuffer,
  upstreamModel: string,
  publicModel: string,
): ArrayBuffer {
  try {
    const o = JSON.parse(new TextDecoder().decode(ab)) as JsonValue;
    const scrubbed = scrubJsonStrings(o, upstreamModel, publicModel);
    return new TextEncoder().encode(JSON.stringify(scrubbed)).buffer as ArrayBuffer;
  } catch {
    // not JSON — passthrough (unparseable bodies are replaced wholesale below)
  }
  return ab;
}

/**
 * Safe client-facing error for upstream failures: never forwards CPA's raw
 * body. Status code passes through unchanged (no leak risk in the code).
 * The body is always our own JSON shape; if CPA sent JSON, its strings have
 * every upstream id / provider-label occurrence replaced by the public id.
 * If the body is not JSON, returns a generic message.
 */
function safeUpstreamError(
  rawText: string,
  upstreamStatus: number,
  upstreamModel: string,
  publicModel: string,
  providerLabel: string,
): Response {
  const status = upstreamStatus; // status codes carry no upstream-id leak; bodies do
  let payload: unknown = {
    error: {
      message: `Upstream request failed (${upstreamStatus}).`,
      type: "upstream_error",
      code: "upstream_error",
    },
  };
  try {
    const parsed = JSON.parse(rawText) as JsonValue;
    if (typeof parsed === "object" && parsed !== null) {
      payload = scrubJsonStrings(parsed, upstreamModel, publicModel, [
        [providerLabel, publicModel],
      ]);
    }
  } catch {
    // not JSON — keep the generic payload
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Line-buffered SSE rewriter: swaps the upstream model id for the public id
 * in every parseable `data: {…}` chunk. Non-JSON lines pass through verbatim.
 */
/**
 * True when an SSE event carries the first real generated content: a token /
 * content delta. Role-only chunks, usage-only chunks, pings and empty deltas
 * do not count as first token.
 */
function isFirstTokenEvent(obj: JsonValue, protocol: "chat" | "responses"): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (protocol === "chat") {
    if (!Array.isArray(o.choices) || o.choices.length === 0) return false;
    const delta = (o.choices[0] as Record<string, unknown> | null)?.delta;
    if (typeof delta !== "object" || delta === null) return false;
    const d = delta as Record<string, unknown>;
    const text =
      (typeof d.content === "string" && d.content.length > 0) ||
      (typeof d.reasoning_content === "string" && d.reasoning_content.length > 0) ||
      (typeof d.reasoning === "string" && d.reasoning.length > 0);
    if (text) return true;
    // tool_calls count as first token only when actual argument content is
    // streaming; id/type/name metadata alone does not.
    return (
      Array.isArray(d.tool_calls) &&
      d.tool_calls.some(
        (tc) =>
          typeof tc === "object" &&
          tc !== null &&
          typeof (tc as Record<string, unknown>).function === "object" &&
          (tc as Record<string, unknown>).function !== null &&
          typeof ((tc as Record<string, unknown>).function as Record<string, unknown>).arguments ===
            "string" &&
          (
            ((tc as Record<string, unknown>).function as Record<string, unknown>)
              .arguments as string
          ).length > 0,
      )
    );
  }
  // Responses SSE: generated content arrives as *.delta events (text, function
  // call arguments). Completed/usage/ping events are not first-token.
  const type = typeof o.type === "string" ? o.type : "";
  if (!type.endsWith(".delta")) return false;
  return typeof o.delta === "string" && o.delta.length > 0;
}

function sseModelRewriteStream(
  source: ReadableStream<Uint8Array>,
  upstreamModel: string,
  publicModel: string,
  protocol: "chat" | "responses",
  onFirstToken?: (obj: JsonValue) => void,
) {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const reader = source.getReader();
  let buf = "";
  const rewriteLine = (line: string): string => {
    if (!line.startsWith("data: ")) return line;
    try {
      const o = JSON.parse(line.slice(6)) as JsonValue;
      if (onFirstToken && isFirstTokenEvent(o, protocol)) onFirstToken(o);
      return `data: ${JSON.stringify(scrubJsonStrings(o, upstreamModel, publicModel))}`;
    } catch {
      // not JSON — passthrough
    }
    return line;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          buf += dec.decode();
          if (buf) controller.enqueue(enc.encode(rewriteLine(buf)));
          controller.close();
          return;
        }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        if (lines.length) controller.enqueue(enc.encode(lines.map(rewriteLine).join("\n") + "\n"));
      } catch (err) {
        controller.error(err instanceof Error ? err : new Error("stream error"));
      }
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });
}

function gatewayHandler(db: Db, path: string, protocol: "chat" | "responses") {
  // Timing uses the monotonic clock: ttft (streams: first real token event;
  // non-stream: not applicable) and total latency to settled completion.
  const monotonic = () => performance.now();
  const roundMs = (n: number) => Math.round(n);
  return async ({ request }: { request: Request }): Promise<Response> => {
    // 1. Disabled gate before any DB write (the body gates below keep the
    // preflight side-effect-free: no DB write before they pass).
    if (process.env.HBR_GATEWAY_ENABLED === "0") {
      return jsonError(503, "gateway_disabled", "Paid gateway is disabled");
    }

    // 2. Auth lookup only — needed to resolve the body limit. NO writes yet:
    // the preflight (size gates) must be side-effect-free, so last_used_at is
    // written only after both gates pass below.
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const key = token ? await verifyApiKey(db, token) : null;
    if (!key) return openAiError(401, "Invalid API key provided.", "invalid_api_key");

    // 3. Body validation — size-limited BEFORE buffering (memory DoS guard).
    // Cap resolution: chat-purpose provenance lifts the cap only on the exact
    // chat path; /v1/responses and every generic key stay at 1 MiB.
    const bodyLimit =
      path === "/v1/chat/completions" && key.purpose === "chat"
        ? CHAT_MAX_BODY_BYTES
        : MAX_BODY_BYTES;
    const limitLabel = `${Math.floor(bodyLimit / (1024 * 1024))} MiB`;
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isSafeInteger(declaredLength) && declaredLength > bodyLimit) {
      return jsonError(413, "payload_too_large", `Request body exceeds ${limitLabel}`);
    }
    const bodyReader = request.body?.getReader();
    if (!bodyReader) return jsonError(400, "INVALID", "Body must be a JSON object");
    let bodyBytes = 0;
    const chunks: Uint8Array[] = [];
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await bodyReader.read();
      if (done) break;
      bodyBytes += value.byteLength;
      if (bodyBytes > bodyLimit) {
        await bodyReader.cancel().catch(() => {});
        return jsonError(413, "payload_too_large", `Request body exceeds ${limitLabel}`);
      }
      chunks.push(value);
    }

    // Both gates passed — the first (and only) DB write of the preflight.
    await db
      .update(apiKeys)
      .set({ last_used_at: Date.now() })
      .where(eq(apiKeys.id, key.api_key_id));
    const raw = decoder.decode(Buffer.concat(chunks));
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
    // hoborouter/auto resolves ONCE here to a concrete published model before
    // cap/reserve; everything downstream (billing, streaming, scrubbing) runs
    // on the resolved model via the unchanged existing path. No eligible
    // candidate falls back to the configured auto model's own single route.
    const resolved =
      body.model === AUTO_PUBLIC_ID
        ? ((await resolveAutoModel(db, {
            apiKeyId: key.api_key_id,
            body,
            bodyBytes: Buffer.byteLength(raw),
            fxRate: intEnv("HBR_USD_VND_RATE", 26000),
          })) ?? (await resolveModel(db, body.model)))
        : await resolveModel(db, body.model);
    if (!resolved) return jsonError(404, "model_not_found", `Model '${body.model}' not found`);
    const { model, mapping, price } = resolved;
    const cachingOn = await effectiveCachingOn(db, model.prompt_caching);
    if (!(await isModelAllowed(db, key.api_key_id, model.id))) {
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

    // 5. Funding selection (O3) + reserve -> markDispatching (committed) -> exactly one fetch.
    // Subscription wallet only when the workspace has an active unexpired
    // subscription (plan's per-minute limit applies) and the limiter says
    // underLimit; reserveRequest re-checks availability inside the txn and
    // falls back to the topup wallet otherwise (no limit). A request counts
    // toward the limit only when it is actually funded by the subscription
    // wallet, so the tentative slot is returned on fallback/failure.
    const limNow = rateLimitNow();

    // Prepaid throughput allowance (gateway admission limit): an active
    // allowance caps ALL workspace traffic regardless of funding source —
    // wallet kind does not matter, admission does. Lazy expiry/promotion
    // runs first so a lapsed or queued window never misstates the cap.
    // Product wording: this is a purchased admission cap, never a
    // provider-capacity guarantee or priority promise.
    try {
      await transitionThroughputAllowances(db, key.workspace_id, limNow);
    } catch {
      // Best-effort lazy transition (e.g. concurrent promotion lost the
      // unique-index race): the stored window state is still consistent;
      // the next request or settlement retries the transition.
    }
    const allowanceRows = await db
      .select({ rpm: throughputAllowances.requests_per_minute })
      .from(throughputAllowances)
      .where(
        and(
          eq(throughputAllowances.workspace_id, key.workspace_id),
          eq(throughputAllowances.status, "active"),
          lte(throughputAllowances.starts_at, limNow),
          gt(throughputAllowances.ends_at, limNow),
        ),
      )
      .limit(1);
    const allowanceLimit = allowanceRows[0]?.rpm ?? null;
    const allowanceCheck =
      allowanceLimit !== null
        ? checkThroughputAllowanceLimit(key.workspace_id, allowanceLimit, limNow)
        : null;

    const subPlans = await db
      .select({ rate: subscriptionPlans.rate_limit_per_minute })
      .from(subscriptions)
      .innerJoin(subscriptionPlans, eq(subscriptions.plan_id, subscriptionPlans.id))
      .where(
        and(
          eq(subscriptions.workspace_id, key.workspace_id),
          eq(subscriptions.status, "active"),
          gt(subscriptions.current_period_end, limNow),
        ),
      )
      .limit(1);
    const limit = subPlans[0]?.rate ?? null;
    const limiter =
      limit !== null ? checkSubscriptionRateLimit(key.workspace_id, limit, limNow) : null;
    const rateLimited = (retryAfterSec: number, code: string, message: string) =>
      new Response(
        JSON.stringify({
          error: { message, type: "rate_limit_error", code },
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(retryAfterSec),
          },
        },
      );

    // Allowance over cap: 429 before any other check — no slot was counted
    // by either limiter, so there is nothing to undo.
    if (allowanceCheck && !allowanceCheck.underLimit) {
      return rateLimited(
        allowanceCheck.retryAfterSec,
        "throughput_allowance_limited",
        "Prepaid throughput allowance limit exceeded. This is a gateway admission limit for your workspace; retry after the window ends.",
      );
    }

    const requestId = crypto.randomUUID();
    const stream = body.stream === true;
    try {
      const reserved = await reserveRequest(db, {
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
        ...(limiter ? { funding: { underLimit: limiter.underLimit } } : {}),
        now: Date.now(),
      });
      // Return the tentative slot ONLY when the ticket actually counted
      // (underLimit): over-limit requests never incremented, so uncounting
      // them would erode quota already used by under-limit requests. The
      // ticket's windowStart guards against subtracting a newer window.
      // The allowance slot caps ALL traffic, so any successful reserve
      // consumes it — only reserve failures return it below.
      if (limiter?.underLimit && reserved.walletKind !== "subscription") {
        uncountSubscriptionRateLimit(key.workspace_id, limiter.windowStart);
      }
    } catch (err) {
      if (err instanceof WalletError) {
        if (limiter?.underLimit)
          uncountSubscriptionRateLimit(key.workspace_id, limiter.windowStart);
        // Reserve failed: return the allowance admission slot so the next
        // request is not falsely 429'd against quota it never used.
        if (allowanceCheck?.underLimit)
          uncountThroughputAllowanceLimit(key.workspace_id, allowanceCheck.windowStart);
        if (err.code === "insufficient") {
          // Over the limit and the topup wallet cannot fund it -> 429 (O3);
          // a 429 writes no rows. Otherwise 402 as today.
          if (limiter && !limiter.underLimit) {
            // The sub-limited slot was returned above only after the
            // allowance slot was returned too — both tentatively counted.
            return rateLimited(
              limiter.retryAfterSec,
              "subscription_rate_limited",
              "Subscription rate limit exceeded. Retry after the window ends or use top-up credit.",
            );
          }
          return jsonError(402, "insufficient_balance", "Insufficient wallet balance");
        }
      }
      throw err;
    }

    const done = { settled: false };
    const releaseOrFail = async (err: unknown): Promise<Response> => {
      try {
        await releaseRequest(db, requestId, Date.now());
      } catch {
        // dispatching already? markDispatching happens right after; safe to ignore here.
      }
      void err;
      return jsonError(400, "INVALID", "Request could not be prepared");
    };

    try {
      await markDispatching(db, requestId, Date.now());
    } catch (err) {
      return await releaseOrFail(err);
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
    const t0 = monotonic();
    const base = (process.env.CPA_BASE_URL || "http://cpa:8317").replace(/\/$/, "");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      // Inbound authorization/cookie/x-forwarded-*/x-request-id are never forwarded.
      authorization: `Bearer ${accessKey}`,
    };
    let upstream: Response;
    // Timeout only for receiving upstream response HEADERS; not streaming.
    const headerTimeout = setTimeout(
      () => controller.abort(),
      intEnv("HBR_UPSTREAM_HEADERS_TIMEOUT_MS", 120000),
    );
    try {
      upstream = await fetch(base + path, {
        method: "POST",
        headers,
        body: JSON.stringify(outbound),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(headerTimeout);
      if (request.signal.aborted) {
        await settle(db, requestId, { kind: "full_hold", reason: "client_abort" }, done);
        return jsonError(499, "client_abort", "Client aborted the request");
      }
      await settle(
        db,
        requestId,
        { kind: "full_hold", reason: "upstream_error", metadata: err },
        done,
      );
      return jsonError(502, "upstream_error", "Upstream dispatch failed");
    }
    clearTimeout(headerTimeout);

    const traceId = upstream.headers.get("x-cpa-trace-id");
    if (traceId)
      await db.update(requests).set({ cpa_trace_id: traceId }).where(eq(requests.id, requestId));

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
      await settle(db, requestId, { kind: "full_hold", reason: "upstream_error" }, done);
      const errRes = safeUpstreamError(
        text,
        upstream.status,
        mapping.upstream_model,
        model.public_id,
        model.provider,
      );
      errRes.headers.set("x-hbr-request-id", requestId);
      return errRes;
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
          await settle(db, requestId, { kind: "full_hold", reason: "client_abort" }, done);
        } else {
          await settle(db, requestId, { kind: "full_hold", reason: "upstream_error" }, done);
        }
        return jsonError(502, "upstream_error", "Upstream body read failed");
      }
      const buf = new Uint8Array(ab);
      tap.push(buf);
      const result = tap.end();
      // Non-stream: TTFT is not applicable (no incremental first token);
      // record only total latency.
      await settleFromTap(db, requestId, result, rates, meta, cachingOn, done, {
        latencyMs: roundMs(monotonic() - t0),
      });
      const body = rewriteJsonModel(ab, mapping.upstream_model, model.public_id);
      return new Response(body, {
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
      await settle(db, requestId, { kind: "full_hold", reason: "upstream_error" }, done);
      return jsonError(502, "upstream_error", "Upstream returned no body");
    }
    // Pull-based passthrough: client cancel() triggers cancel() below.
    const reader = source.getReader();
    let streamedSettle = false;
    let ttftMs: number | undefined;
    const settleStreamEnd = async () => {
      if (streamedSettle) return;
      streamedSettle = true;
      await settleFromTap(db, requestId, tap.end(), rates, meta, cachingOn, done, {
        latencyMs: roundMs(monotonic() - t0),
        ...(ttftMs === undefined ? {} : { ttftMs }),
      });
    };
    const passthrough = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done: upstreamDone, value } = await reader.read();
          if (upstreamDone) {
            // Settle BEFORE closing: the consumer's res.text() resolves as
            // soon as close is signaled; settlement must be durable by then.
            await settleStreamEnd();
            controller.close();
            return;
          }
          tap.push(value);
          controller.enqueue(value);
        } catch (err) {
          if (!done.settled && !streamedSettle) {
            streamedSettle = true;
            if (request.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
              tap.abort("client_abort");
              await settle(db, requestId, { kind: "full_hold", reason: "client_abort" }, done);
            } else {
              await settle(db, requestId, { kind: "full_hold", reason: "upstream_error" }, done);
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
          // Sync cancel context: best-effort settlement; a settlement failure
          // here must not crash the stream teardown.
          void settle(db, requestId, { kind: "full_hold", reason: "client_abort" }, done).catch(
            () => {},
          );
        }
      },
    });
    request.signal.addEventListener("abort", () => controller.abort(), { once: true });
    return new Response(
      sseModelRewriteStream(
        passthrough,
        mapping.upstream_model,
        model.public_id,
        protocol,
        (obj) => {
          if (ttftMs === undefined) ttftMs = roundMs(monotonic() - t0);
          void obj;
        },
      ),
      {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
          // Reverse proxies (nginx, Caddy, Cloudflare) re-buffer SSE without these.
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
          "x-hbr-request-id": requestId,
        },
      },
    );
  };
}

export const gatewayRoutes = (db: Db) =>
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
