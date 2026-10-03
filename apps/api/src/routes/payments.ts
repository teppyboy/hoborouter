// Task 9: payments routes (member+, workspace-scoped) + manual top-up creation.
// Manual payments are admin-approved: creation is always available (no env
// gate); completion happens via the instance-admin complete endpoint. The
// legacy signed mock webhook stays for pre-existing 'mock' provider rows and
// is never routed for new 'manual' rows.
// payOS: provider=payos creates a pending row + audit atomically, then calls
// payOS for the checkout URL. Return/cancel redirect URLs are display-only —
// /webhooks/payments/payos is the sole credit path.
import { Elysia, t } from "elysia";
import type { Db } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, writeAudit, jsonError } from "../authz";
import { requirePositiveSafeInteger } from "@hoborouter/wallet";
import { eq } from "drizzle-orm";
import { workspaces, payments } from "@hoborouter/db";
import {
  PayOSProvider,
  payosConfigFromEnv,
  payosNextOrderCode,
  type PayosConfig,
} from "@hoborouter/payments";

export const paymentsRoutes = (
  db: Db,
  auth: BetterAuthInstance,
  payos: PayosConfig = payosConfigFromEnv(),
  payosFetch?: (input: string | URL, init?: RequestInit) => Promise<Response>,
) => {
  // payOS branch of payment creation: persist pending + audit atomically, then
  // create the checkout link. Remote failure marks the row failed and returns a
  // safe 502 — no upstream body or credentials ever reach the response.
  const createPayosPayment = async (workspaceId: string, userId: string, amount: number) => {
    const id = crypto.randomUUID();
    const orderCode = payosNextOrderCode();
    const now = Date.now();
    await db.transaction(async (tx) => {
      await tx.insert(payments).values({
        id,
        workspace_id: workspaceId,
        amount,
        status: "pending",
        provider: "payos",
        provider_order_code: String(orderCode),
        created_at: now,
      });
      await writeAudit(tx, {
        actorUserId: userId,
        workspaceId,
        action: "payment.create",
        target: id,
        detail: { amount, provider: "payos" },
      });
    });
    // Same canonical base as auth.ts; redirect pages are display-only (the
    // webhook is the sole credit path).
    const base = process.env.BETTER_AUTH_URL || process.env.HBR_BASE_URL || "http://localhost:3000";
    const redirectUrl = `${base}/billing/payments?payment=${id}`;
    const client = new PayOSProvider(
      { clientId: payos.clientId, apiKey: payos.apiKey, checksumKey: payos.checksumKey },
      payosFetch,
    );
    try {
      const created = await client.createPayment({
        paymentId: id,
        amountVnd: amount,
        description: "topup",
        orderCode,
        returnUrl: redirectUrl,
        cancelUrl: redirectUrl,
      });
      return new Response(
        JSON.stringify({
          id,
          amount,
          status: "pending",
          provider: "payos",
          provider_order_code: String(orderCode),
          checkout_url: created.checkoutUrl,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    } catch {
      await db.update(payments).set({ status: "failed" }).where(eq(payments.id, id));
      return jsonError(502, "PROVIDER_UNAVAILABLE", "payment provider failed to create checkout");
    }
  };

  return (
    new Elysia({ name: "payments" })
      .post(
        "/api/v1/workspaces/:id/payments",
        {
          params: t.Object({ id: t.String() }),
          body: t.Optional(
            t.Object({
              amount: t.Optional(t.Number()),
              provider: t.Optional(t.Union([t.Literal("manual"), t.Literal("payos")])),
            }),
          ),
          response: t.Object({
            id: t.String(),
            amount: t.Number(),
            status: t.String(),
            provider: t.String(),
            provider_order_code: t.String(),
            checkout_url: t.String(),
          }),
          detail: {
            tags: ["Payments"],
            summary: "Create payment",
            description:
              "Create a pending top-up. provider=manual (default) is completed only by an instance admin; provider=payos returns a payOS checkout_url when payOS is configured.",
            security: [{ cookieAuth: [] }],
          },
        },
        async ({ request, params, body }) => {
          const gate = await requireSession(auth, request);
          if (gate.error) return gate.error;
          const userId = gate.session.user.id;
          const denied = await requireWsRole(db, params.id, userId, "member");
          if (denied) return denied;
          const wsRows = await db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, params.id))
            .limit(1);
          if (!wsRows[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
          const raw = (body as { amount?: unknown } | null)?.amount;
          let amount: number;
          try {
            amount = requirePositiveSafeInteger("amount", raw);
          } catch {
            return jsonError(400, "INVALID", "amount must be a positive integer VND amount");
          }
          const providerChoice = (body as { provider?: string } | null)?.provider;
          if (providerChoice === "payos") {
            if (!payos.available) {
              return jsonError(503, "PROVIDER_UNAVAILABLE", "payOS is not configured");
            }
            return createPayosPayment(params.id, userId, amount);
          }
          const id = crypto.randomUUID();
          const orderCode = `MANUAL-${id}`;
          const now = Date.now();
          await db.transaction(async (tx) => {
            await tx.insert(payments).values({
              id,
              workspace_id: params.id,
              amount,
              status: "pending",
              provider: "manual",
              provider_order_code: orderCode,
              created_at: now,
            });
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: params.id,
              action: "payment.create",
              target: id,
              detail: { amount, provider: "manual" },
            });
          });
          // No provider checkout: admin approval happens out-of-band; the
          // member tracks status in the billing UI.
          return new Response(
            JSON.stringify({
              id,
              amount,
              status: "pending",
              provider: "manual",
              provider_order_code: orderCode,
              checkout_url: `/billing/payments?payment=${id}`,
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        },
      )
      .get(
        "/api/v1/workspaces/:id/payments/:paymentId",
        {
          params: t.Object({ id: t.String(), paymentId: t.String() }),
          detail: {
            tags: ["Payments"],
            summary: "Get payment",
            security: [{ cookieAuth: [] }],
          },
        },
        async ({ request, params }) => {
          const gate = await requireSession(auth, request);
          if (gate.error) return gate.error;
          const userId = gate.session.user.id;
          const denied = await requireWsRole(db, params.id, userId, "member");
          if (denied) return denied;
          const rows = await db
            .select({ workspace_id: payments.workspace_id })
            .from(payments)
            .where(eq(payments.id, params.paymentId))
            .limit(1);
          const row = rows[0];
          if (!row) return jsonError(404, "NOT_FOUND", "Payment not found");
          if (row.workspace_id !== params.id)
            return jsonError(403, "FORBIDDEN", "Payment belongs to another workspace");
          const paymentRows = await db
            .select({
              id: payments.id,
              workspace_id: payments.workspace_id,
              amount: payments.amount,
              status: payments.status,
              provider: payments.provider,
              provider_order_code: payments.provider_order_code,
              created_at: payments.created_at,
            })
            .from(payments)
            .where(eq(payments.id, params.paymentId))
            .limit(1);
          return new Response(JSON.stringify(paymentRows[0]), {
            headers: { "content-type": "application/json" },
          });
        },
      )
      // Safe capability endpoint: which payment providers are enabled. No
      // secrets, no configuration detail — only the boolean.
      .get(
        "/api/v1/payment-methods",
        {
          response: t.Object({ manual: t.Boolean(), payos: t.Boolean() }),
          detail: {
            tags: ["Payments"],
            summary: "List available payment methods",
            security: [{ cookieAuth: [] }],
          },
        },
        async ({ request }) => {
          const gate = await requireSession(auth, request);
          if (gate.error) return gate.error;
          return new Response(JSON.stringify({ manual: true, payos: payos.available }), {
            headers: { "content-type": "application/json" },
          });
        },
      )
  );
};
