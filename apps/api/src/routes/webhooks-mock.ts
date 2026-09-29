// Task 9: guarded mock payment webhook. payOS-shaped, HMAC-verified,
// idempotent top-up. Feature-gated: enabled ONLY when HBR_MOCK_PAYMENTS=on AND
// NODE_ENV !== 'production' — otherwise the route 404s, even with the flag on
// in production. No real provider calls anywhere; dev/demo only.
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import {
  verifyMockSignature,
  MockPaymentError,
  processMockPaymentEvent,
} from "@hoborouter/payments";
import { jsonError } from "../authz";
import { mockWebhookConfig, type MockWebhookConfig } from "../mock-config";

export const mockWebhookRoutes = (db: Database, cfg: MockWebhookConfig) => {
  const enabled = cfg.enabled;
  return new Elysia({ name: "webhooks-mock" }).post(
    "/webhooks/payments/mock",
    async ({ request }) => {
      if (!enabled) {
        return jsonError(404, "NOT_FOUND", "Not found");
      }
      // Nonempty-key invariant is enforced by mockWebhookConfig at app build.
      const raw = await request.text();
      const signatureValid = await verifyMockSignature(raw, cfg.webhookKey);
      if (!signatureValid) {
        return jsonError(400, "INVALID_SIGNATURE", "signature verification failed");
      }
      let event: {
        provider_order_code?: unknown;
        provider_reference?: unknown;
        amount?: unknown;
      };
      try {
        event = JSON.parse(raw);
      } catch {
        return jsonError(400, "INVALID", "malformed JSON");
      }
      const orderCode =
        typeof event.provider_order_code === "string" ? event.provider_order_code : "";
      const providerReference =
        typeof event.provider_reference === "string" ? event.provider_reference : "";
      const amount = typeof event.amount === "number" ? event.amount : Number.NaN;
      if (!orderCode || !providerReference) {
        return jsonError(400, "INVALID", "provider_order_code and provider_reference are required");
      }
      try {
        const result = processMockPaymentEvent(db, {
          orderCode,
          providerReference,
          amount,
          rawPayload: raw,
        });
        // 2xx only after durable commit; replays also get 2xx, no second credit.
        return new Response(JSON.stringify({ status: "ok", outcome: result.outcome }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        if (err instanceof MockPaymentError) {
          if (
            err.code === "amount_mismatch" ||
            err.code === "invalid" ||
            err.code === "not_found"
          ) {
            return jsonError(400, err.code.toUpperCase(), err.message);
          }
        }
        throw err;
      }
    },
  );
};

export { mockWebhookConfig };
