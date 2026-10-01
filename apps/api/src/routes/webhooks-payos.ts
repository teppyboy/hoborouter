// Task 4: POST /webhooks/payments/payos — raw-body payOS webhook. Verifies the
// payOS signature (checksum key from env), then credits through the same
// idempotent payment_events path as the mock webhook. 200 {success:true} for
// valid events including idempotent replays; 400 for bad signature, malformed
// payload, unknown order, or amount mismatch — never a wallet change, and
// never any secret in logs or responses.
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import {
  PayOSProvider,
  PayosWebhookError,
  MockPaymentError,
  processMockPaymentEvent,
  type PayosWebhookConfig,
} from "@hoborouter/payments";
import { jsonError } from "../authz";

export const payosWebhookRoutes = (db: Database, cfg: PayosWebhookConfig) => {
  const provider = new PayOSProvider({
    clientId: "",
    apiKey: "",
    checksumKey: cfg.checksumKey,
  });
  return new Elysia({ name: "webhooks-payos" }).post(
    "/webhooks/payments/payos",
    async ({ request }) => {
      if (!cfg.available) {
        return jsonError(404, "NOT_FOUND", "Not found");
      }
      const raw = await request.text();
      let event;
      try {
        event = provider.verifyWebhook(raw);
      } catch (err) {
        if (err instanceof PayosWebhookError) {
          return jsonError(400, "INVALID_SIGNATURE", err.message);
        }
        throw err;
      }
      // Cancelled/failed webhooks never reach the credit path.
      if (event.status !== "paid") {
        return new Response(JSON.stringify({ success: true, status: event.status }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      try {
        processMockPaymentEvent(db, {
          provider: "payos",
          orderCode: event.orderCode,
          providerReference: event.providerRef,
          amount: event.amountVnd,
          rawPayload: raw,
        });
        // 2xx only after durable commit; replays also 2xx, no second credit.
        return new Response(JSON.stringify({ success: true }), {
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
