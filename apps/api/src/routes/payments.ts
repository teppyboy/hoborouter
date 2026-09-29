// Task 9: payments routes (member+, workspace-scoped) + mock checkout link.
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, writeAudit, jsonError } from "../authz";
import { requirePositiveSafeInteger } from "@hoborouter/wallet";
import type { MockWebhookConfig } from "../mock-config";

export const paymentsRoutes = (
  db: Database,
  auth: BetterAuthInstance,
  mockCfg: MockWebhookConfig,
) =>
  new Elysia({ name: "payments" })
    .post("/api/workspaces/:id/payments", async ({ request, params, body }) => {
      if (!mockCfg.enabled) {
        // Dev/demo only — no mock payment creation in production or when off.
        return jsonError(404, "NOT_FOUND", "Not found");
      }
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const userId = gate.session.user.id;
      const denied = requireWsRole(db, params.id, userId, "member");
      if (denied) return denied;
      const ws = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(params.id);
      if (!ws) return jsonError(404, "NOT_FOUND", "Workspace not found");
      const raw = (body as { amount?: unknown } | null)?.amount;
      let amount: number;
      try {
        amount = requirePositiveSafeInteger("amount", raw);
      } catch {
        return jsonError(400, "INVALID", "amount must be a positive integer VND amount");
      }
      const id = crypto.randomUUID();
      const orderCode = `MOCK-${id}`;
      const now = Date.now();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES (?,?,?,'pending','mock',?,?)",
        ).run(id, params.id, amount, orderCode, now);
        writeAudit(db, {
          actorUserId: userId,
          workspaceId: params.id,
          action: "payment.create",
          target: id,
          detail: { amount, provider: "mock" },
        });
      })();
      // Dev/demo only — never a real provider checkout.
      return new Response(
        JSON.stringify({
          id,
          amount,
          status: "pending",
          provider: "mock",
          provider_order_code: orderCode,
          checkout_url: `/webhooks/payments/mock?order=${orderCode}`,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    })
    .get("/api/workspaces/:id/payments/:paymentId", async ({ request, params }) => {
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const userId = gate.session.user.id;
      const denied = requireWsRole(db, params.id, userId, "member");
      if (denied) return denied;
      const row = db
        .prepare("SELECT workspace_id FROM payments WHERE id = ?")
        .get(params.paymentId) as { workspace_id: string } | undefined;
      if (!row) return jsonError(404, "NOT_FOUND", "Payment not found");
      if (row.workspace_id !== params.id)
        return jsonError(403, "FORBIDDEN", "Payment belongs to another workspace");
      const payment = db
        .prepare(
          "SELECT id, workspace_id, amount, status, provider, provider_order_code, created_at FROM payments WHERE id = ?",
        )
        .get(params.paymentId);
      return new Response(JSON.stringify(payment), {
        headers: { "content-type": "application/json" },
      });
    });
