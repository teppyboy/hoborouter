// Prepaid throughput allowance product routes (member+, workspace-scoped).
// Catalog + purchase mirror the bundle flow: payment amount is ALWAYS the
// server-side product price, creation only persists a pending payment, and
// settlement (verified webhook or instance-admin complete) is the sole
// activation path. A purchase grants NO wallet credit — it activates a
// fixed-window gateway admission cap for the workspace.
//
// Product wording is normative: this is a "Prepaid throughput allowance" — a
// gateway admission limit. Never describe it as a provider-capacity
// guarantee or a priority promise.
import { Elysia, t } from "elysia";
import type { Db } from "@hoborouter/db";
import { payments, throughputAllowances, throughputProducts } from "@hoborouter/db";
import { and, asc, eq } from "drizzle-orm";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, wsRole, writeAudit, jsonError } from "../authz";
import { payosConfigFromEnv, type PayosConfig } from "@hoborouter/payments";
import { transitionThroughputAllowances } from "@hoborouter/payments";
import { makePayosPaymentCreator } from "./payments";
import { readPaymentLimits, paymentDeadlineMs, withinPaymentCap } from "../payment-creation";

export const throughputRoutes = (
  db: Db,
  auth: BetterAuthInstance,
  payos: PayosConfig = payosConfigFromEnv(),
  payosFetch?: (input: string | URL, init?: RequestInit) => Promise<Response>,
) => {
  const createPayosPayment = makePayosPaymentCreator(db, payos, payosFetch);

  // Workspace gate for purchase routes: unknown workspace AND non-member both
  // answer 404 so workspace existence is not revealed to outsiders.
  const requireWsMember = async (workspaceId: string, userId: string) => {
    const role = await wsRole(db, workspaceId, userId);
    if (!role) return jsonError(404, "NOT_FOUND", "Workspace not found");
    return null;
  };

  // Manual (admin-approved) pending purchase; mirrors the bundle manual
  // branch but carries the throughput_product_id FK on the payment row.
  // Products are VND-only, so the amount is the stored price and the
  // deadline/cap read lives inside the insert transaction.
  const createManualPurchase = async (
    workspaceId: string,
    userId: string,
    product: { id: string; price_vnd: number },
  ): Promise<Response> => {
    const id = crypto.randomUUID();
    const now = Date.now();
    let response: Response | null = null;
    let resolvedAmount = 0;
    await db.transaction(async (tx) => {
      const limits = await readPaymentLimits(tx);
      if (!withinPaymentCap(product.price_vnd, limits.maxAmountVnd)) {
        response = jsonError(400, "INVALID", "payment amount exceeds the configured maximum");
        return;
      }
      resolvedAmount = product.price_vnd;
      const deadline = paymentDeadlineMs(now, limits.timeoutMinutes);
      await tx.insert(payments).values({
        id,
        workspace_id: workspaceId,
        amount: resolvedAmount,
        status: "pending",
        provider: "manual",
        provider_order_code: `MANUAL-${id}`,
        created_at: now,
        expires_at: deadline,
        throughput_product_id: product.id,
        input_currency: "VND",
        input_amount_text: String(resolvedAmount),
        fx_rate_vnd_per_usd: null,
      });
      await writeAudit(tx, {
        actorUserId: userId,
        workspaceId,
        action: "payment.create",
        target: id,
        detail: {
          amount: resolvedAmount,
          provider: "manual",
          expires_at: deadline,
          input_currency: "VND",
          input_amount_text: String(resolvedAmount),
          throughput_product_id: product.id,
        },
      });
    });
    if (response) return response;
    return new Response(
      JSON.stringify({
        id,
        amount: resolvedAmount,
        status: "pending",
        provider: "manual",
        provider_order_code: `MANUAL-${id}`,
        checkout_url: `/billing/payments?payment=${id}`,
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  };

  return new Elysia({ name: "throughput" })
    .get(
      "/api/v1/throughput-products",
      {
        detail: {
          tags: ["Billing"],
          summary: "List active prepaid throughput allowance products",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const gate = await requireSession(auth, request);
        if (gate.error) return gate.error;
        const rows = await db
          .select({
            id: throughputProducts.id,
            name: throughputProducts.name,
            price_vnd: throughputProducts.price_vnd,
            requests_per_minute: throughputProducts.requests_per_minute,
            duration_days: throughputProducts.duration_days,
          })
          .from(throughputProducts)
          .where(eq(throughputProducts.active, true))
          .orderBy(asc(throughputProducts.created_at));
        return new Response(JSON.stringify({ data: rows }), {
          headers: { "content-type": "application/json" },
        });
      },
    )
    .post(
      "/api/v1/workspaces/:id/throughput-products/:productId/purchase",
      {
        params: t.Object({ id: t.String(), productId: t.String() }),
        body: t.Object({
          provider: t.Optional(t.Union([t.Literal("manual"), t.Literal("payos")])),
        }),
        detail: {
          tags: ["Billing"],
          summary: "Purchase a prepaid throughput allowance",
          description:
            "Creates a pending payment at the server-side product price; provider=payos returns a checkout_url. The allowance activates only on settlement (no wallet credit).",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if (gate.error) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsMember(params.id, userId);
        if (denied) return denied;
        const rows = await db
          .select()
          .from(throughputProducts)
          .where(eq(throughputProducts.id, params.productId))
          .limit(1);
        const product = rows[0];
        if (!product) return jsonError(404, "NOT_FOUND", "Throughput product not found");
        if (!product.active)
          return jsonError(409, "INACTIVE", "Throughput product is not available");
        const provider = (body as { provider?: string } | null)?.provider;
        if (provider === "payos") {
          if (!payos.available)
            return jsonError(503, "PROVIDER_UNAVAILABLE", "payOS is not configured");
          // VND-only products: the cap binds before any provider call or row
          // insert.
          const limits = await readPaymentLimits(db);
          if (!withinPaymentCap(product.price_vnd, limits.maxAmountVnd)) {
            return jsonError(400, "INVALID", "payment amount exceeds the configured maximum");
          }
          return createPayosPayment(params.id, userId, product.price_vnd, {
            throughputProductId: product.id,
          });
        }
        return createManualPurchase(params.id, userId, {
          id: product.id,
          price_vnd: Number(product.price_vnd),
        });
      },
    )
    .get(
      "/api/v1/workspaces/:id/throughput-allowance",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Billing"],
          summary: "Get the workspace's current prepaid throughput allowance",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if (gate.error) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsMember(params.id, userId);
        if (denied) return denied;
        const now = Date.now();
        // Lazy expiry + promotion: a lapsed window reads as expired, a queued
        // window whose start has arrived reads as limiting. Best-effort: a
        // lost promotion race retries on the next read.
        try {
          await transitionThroughputAllowances(db, params.id, now);
        } catch {
          // fall through to the read below
        }
        const rows = await db
          .select({
            requests_per_minute: throughputAllowances.requests_per_minute,
            starts_at: throughputAllowances.starts_at,
            ends_at: throughputAllowances.ends_at,
            status: throughputAllowances.status,
          })
          .from(throughputAllowances)
          .where(
            and(
              eq(throughputAllowances.workspace_id, params.id),
              eq(throughputAllowances.status, "active"),
            ),
          )
          .limit(1);
        const row = rows[0];
        return new Response(
          JSON.stringify({
            allowance:
              row && Number(row.ends_at) > now
                ? {
                    requests_per_minute: row.requests_per_minute,
                    starts_at: Number(row.starts_at),
                    ends_at: Number(row.ends_at),
                    status: row.status,
                    // A queued window has not started limiting yet.
                    limiting: Number(row.starts_at) <= now,
                  }
                : null,
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    );
};
