// Chat receipts client (apps/web/src/pages/chat/receipts.ts): real helper
// outputs against a mocked native fetch, same style as chat-history-client.
// Money contract:
// - GET /api/v1/workspaces/:id/chat-receipts/:requestId, cookie session only.
// - charged_vnd NULL stays NULL while pending — pending is never displayed
//   as 0; settled/failed show the ACTUAL charged VND via the shared formatter.
// - Malformed bodies are never trusted (invalid), statuses map to errors.
import { describe, test, expect, beforeEach } from "bun:test";
import { chargedVndLabel, fetchChatReceipt } from "../apps/web/src/pages/chat/receipts";
import { ConversationError } from "../apps/web/src/pages/chat/conversations";

let calls: Array<{ url: string; init: RequestInit }>;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Mock fetch with the full fetch surface (preconnect included). */
function asFetch(fn: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
  const f = fn as unknown as typeof fetch;
  f.preconnect = () => {};
  return f;
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = asFetch(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(200, {
      request_id: "req_1",
      status: "settled",
      charged_vnd: 124,
      public_model: "gemini-2.5-pro",
      created_at: 1730000000000,
    });
  });
});

describe("fetchChatReceipt", () => {
  test("GETs the member-scoped receipt endpoint with cookie credentials", async () => {
    const r = await fetchChatReceipt("ws1", "req_1");
    expect(r).toEqual({
      request_id: "req_1",
      status: "settled",
      charged_vnd: 124,
      public_model: "gemini-2.5-pro",
      created_at: 1730000000000,
    });
    expect(calls[0]!.url).toBe("/api/v1/workspaces/ws1/chat-receipts/req_1");
    expect(calls[0]!.init.credentials).toBe("include");
    expect(calls[0]!.init.method).toBe("GET");
  });

  test("pending receipt keeps charged_vnd NULL (never coerced to 0)", async () => {
    globalThis.fetch = asFetch(async () =>
      respond(200, {
        request_id: "req_2",
        status: "pending",
        charged_vnd: null,
        public_model: null,
        created_at: 1730000000000,
      }),
    );
    const r = await fetchChatReceipt("ws1", "req_2");
    expect(r.status).toBe("pending");
    expect(r.charged_vnd).toBeNull();
    expect(chargedVndLabel(r)).toBeNull();
  });

  test("failed receipt shows the ACTUAL charged amount (full hold), not 0", async () => {
    globalThis.fetch = asFetch(async () =>
      respond(200, {
        request_id: "req_3",
        status: "failed",
        charged_vnd: 50000,
        public_model: "m",
        created_at: 1730000000000,
      }),
    );
    const r = await fetchChatReceipt("ws1", "req_3");
    expect(chargedVndLabel(r)).toContain("50.000");
  });

  test("malformed body rejects as invalid; 404 maps to notFound", async () => {
    globalThis.fetch = asFetch(async () => respond(200, { status: "settled" }));
    await expect(fetchChatReceipt("ws1", "req_x")).rejects.toMatchObject({
      name: "ConversationError",
      kind: "invalid",
    });
    globalThis.fetch = asFetch(async () => respond(404, { error: {} }));
    await expect(fetchChatReceipt("ws1", "req_x")).rejects.toMatchObject({
      name: "ConversationError",
      kind: "notFound",
      status: 404,
    });
  });

  test("network failure maps to ConversationError network", async () => {
    globalThis.fetch = asFetch(async () => {
      throw new TypeError("boom");
    });
    const err = await fetchChatReceipt("ws1", "req_x").catch((e) => e);
    expect(err).toBeInstanceOf(ConversationError);
    expect((err as ConversationError).kind).toBe("network");
  });

  test("chargedVndLabel: settled formats VND; pending-like null stays null", () => {
    expect(
      chargedVndLabel({
        request_id: "r",
        status: "settled",
        charged_vnd: 124,
        public_model: "m",
        created_at: 0,
      }),
    ).toBe("124 ₫");
    expect(
      chargedVndLabel({
        request_id: "r",
        status: "failed",
        charged_vnd: null,
        public_model: "m",
        created_at: 0,
      }),
    ).toBeNull();
  });
});
