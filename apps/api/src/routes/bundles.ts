// Credit-bundle purchases (member+, workspace-scoped). Payment
// amount is ALWAYS the server-side bundle price — never client supplied.
// Creation only persists a pending payment; the signed PayOS webhook (or the
// instance-admin manual complete) is the sole credit path, identical to
// top-ups. Inactive bundles are rejected (409) so stale client lists
// cannot buy a deactivated price.
import { Elysia, t } from "elysia";
import type { Db } from "@hoborouter/db";
import { creditBundles, payments, subscriptionPlans } from "@hoborouter/db";
import { asc, eq } from "drizzle-orm";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, wsRole, writeAudit, jsonError } from "../authz";
import { payosConfigFromEnv, type PayosConfig } from "@hoborouter/payments";
import { makePayosPaymentCreator } from "./payments";

export const bundlesRoutes = (
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

  // Manual (admin-approved) pending purchase; mirrors the top-up manual
  // branch in payments.ts but carries the bundle FK on the payment row.
  const createManualPurchase = async (
    workspaceId: string,
    userId: string,
    amount: number,
    purchase: { bundleId?: string },
  ) => {
    const id = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(payments).values({
        id,
        workspace_id: workspaceId,
        amount,
        status: "pending",
        provider: "manual",
        provider_order_code: `MANUAL-${id}`,
        created_at: Date.now(),
        bundle_id: purchase.bundleId,
      });
      await writeAudit(tx, {
        actorUserId: userId,
        workspaceId,
        action: "payment.create",
        target: id,
        detail: {
          amount,
          provider: "manual",
          ...(purchase.bundleId ? { bundle_id: purchase.bundleId } : {}),
        },
      });
    });
    return new Response(
      JSON.stringify({
        id,
        amount,
        status: "pending",
        provider: "manual",
        provider_order_code: `MANUAL-${id}`,
        checkout_url: `/billing/payments?payment=${id}`,
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  };

  return (
    new Elysia({ name: "bundles" })
      .get(
        "/api/v1/bundles",
        {
          detail: {
            tags: ["Billing"],
            summary: "List active credit bundles",
            security: [{ cookieAuth: [] }],
          },
        },
        async ({ request }) => {
          const gate = await requireSession(auth, request);
          if (gate.error) return gate.error;
          const rows = await db
            .select({
              id: creditBundles.id,
              name: creditBundles.name,
              price_vnd: creditBundles.price_vnd,
              credit_vnd: creditBundles.credit_vnd,
              bonus_vnd: creditBundles.bonus_vnd,
            })
            .from(creditBundles)
            .where(eq(creditBundles.active, true))
            .orderBy(asc(creditBundles.created_at));
          return new Response(JSON.stringify({ data: rows }), {
            headers: { "content-type": "application/json" },
          });
        },
      )
      .get(
        "/api/v1/subscription-plans",
        {
          detail: {
            tags: ["Billing"],
            summary: "List active subscription plans",
            security: [{ cookieAuth: [] }],
          },
        },
        async ({ request }) => {
          const gate = await requireSession(auth, request);
          if (gate.error) return gate.error;
          const rows = await db
            .select({
              id: subscriptionPlans.id,
              name: subscriptionPlans.name,
              price_vnd: subscriptionPlans.price_vnd,
              credit_per_period_vnd: subscriptionPlans.credit_per_period_vnd,
              period_days: subscriptionPlans.period_days,
            })
            .from(subscriptionPlans)
            .where(eq(subscriptionPlans.active, true))
            .orderBy(asc(subscriptionPlans.created_at));
          return new Response(JSON.stringify({ data: rows }), {
            headers: { "content-type": "application/json" },
          });
        },
      )
      .post(
        "/api/v1/workspaces/:id/bundles/:bundleId/purchase",
        {
          params: t.Object({ id: t.String(), bundleId: t.String() }),
          body: t.Object({
            provider: t.Optional(t.Union([t.Literal("manual"), t.Literal("payos")])),
          }),
          detail: {
            tags: ["Billing"],
            summary: "Purchase a credit bundle",
            description:
              "Creates a pending payment at the server-side bundle price; provider=payos returns a checkout_url. Credit is applied only on settlement.",
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
            .from(creditBundles)
            .where(eq(creditBundles.id, params.bundleId))
            .limit(1);
          const bundle = rows[0];
          if (!bundle) return jsonError(404, "NOT_FOUND", "Bundle not found");
          if (!bundle.active) return jsonError(409, "INACTIVE", "Bundle is not available");
          const provider = (body as { provider?: string } | null)?.provider;
          if (provider === "payos") {
            if (!payos.available)
              return jsonError(503, "PROVIDER_UNAVAILABLE", "payOS is not configured");
            return createPayosPayment(params.id, userId, bundle.price_vnd, {
              bundleId: bundle.id,
            });
          }
          return createManualPurchase(params.id, userId, bundle.price_vnd, {
            bundleId: bundle.id,
          });
        },
      )
  );
};
