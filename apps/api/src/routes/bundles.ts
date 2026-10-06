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
import { payosConfigFromEnv, type PayosConfig, parseUsdCents, usdCentsToVndCeiling } from "@hoborouter/payments";
import { makePayosPaymentCreator } from "./payments";
import {
  readPaymentLimits,
  paymentDeadlineMs,
  withinPaymentCap,
  snapshotForBundlePrice,
} from "../payment-creation";

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
  // branch in payments.ts but carries the bundle/plan FK on the payment row.
  // Deadline snapshot + cap read inside the insert transaction; a price over
  // the configured cap rejects the purchase before any row exists.
  const createManualPurchase = async (
    workspaceId: string,
    userId: string,
    amount: number,
    purchase: { bundleId?: string; subscriptionPlanId?: string },
  ): Promise<Response> => {
    const id = crypto.randomUUID();
    const now = Date.now();
    let response: Response | null = null;
    await db.transaction(async (tx) => {
      const limits = await readPaymentLimits(tx);
      if (!withinPaymentCap(amount, limits.maxAmountVnd)) {
        response = jsonError(400, "INVALID", "payment amount exceeds the configured maximum");
        return;
      }
      const deadline = paymentDeadlineMs(now, limits.timeoutMinutes);
      const snapshot = snapshotForBundlePrice(amount);
      await tx.insert(payments).values({
        id,
        workspace_id: workspaceId,
        amount,
        status: "pending",
        provider: "manual",
        provider_order_code: `MANUAL-${id}`,
        created_at: now,
        expires_at: deadline,
        bundle_id: purchase.bundleId,
        subscription_plan_id: purchase.subscriptionPlanId,
        ...snapshot,
      });
      await writeAudit(tx, {
        actorUserId: userId,
        workspaceId,
        action: "payment.create",
        target: id,
        detail: {
          amount,
          provider: "manual",
          expires_at: deadline,
          input_currency: snapshot.input_currency,
          input_amount_text: snapshot.input_amount_text,
          ...(purchase.bundleId ? { bundle_id: purchase.bundleId } : {}),
          ...(purchase.subscriptionPlanId
            ? { subscription_plan_id: purchase.subscriptionPlanId }
            : {}),
        },
      });
    });
    if (response) return response;
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

  return new Elysia({ name: "bundles" })
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
        const limits = await readPaymentLimits(db);
        const rows = await db
          .select({
            id: creditBundles.id,
            name: creditBundles.name,
            price_vnd: creditBundles.price_vnd,
            credit_vnd: creditBundles.credit_vnd,
            bonus_vnd: creditBundles.bonus_vnd,
            price_usd: creditBundles.price_usd,
            credit_usd: creditBundles.credit_usd,
            bonus_usd: creditBundles.bonus_usd,
            creation_fx_rate_vnd_per_usd: creditBundles.creation_fx_rate_vnd_per_usd,
          })
          .from(creditBundles)
          .where(eq(creditBundles.active, true))
          .orderBy(asc(creditBundles.created_at));
        const data = rows.map((row) => ({
          ...row,
          // USD rows quote at the current payment FX (an estimate until
          // payment creation snapshots it); legacy rows keep their stored
          // price. Catalog rows are never updated for the quote.
          price_vnd:
            row.price_usd !== null
              ? (usdCentsToVndCeiling(parseUsdCents(row.price_usd)!, limits.usdVndRate) ??
                 Number(row.price_vnd))
              : Number(row.price_vnd),
        }));
        return new Response(JSON.stringify({ data, usd_vnd_rate: limits.usdVndRate }), {
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
        const limits = await readPaymentLimits(db);
        const rows = await db
          .select({
            id: subscriptionPlans.id,
            name: subscriptionPlans.name,
            price_vnd: subscriptionPlans.price_vnd,
            credit_per_period_vnd: subscriptionPlans.credit_per_period_vnd,
            period_days: subscriptionPlans.period_days,
            rate_limit_per_minute: subscriptionPlans.rate_limit_per_minute,
            price_usd: subscriptionPlans.price_usd,
            credit_per_period_usd: subscriptionPlans.credit_per_period_usd,
            creation_fx_rate_vnd_per_usd: subscriptionPlans.creation_fx_rate_vnd_per_usd,
          })
          .from(subscriptionPlans)
          .where(eq(subscriptionPlans.active, true))
          .orderBy(asc(subscriptionPlans.created_at));
        const data = rows.map((row) => ({
          ...row,
          price_vnd:
            row.price_usd !== null
              ? (usdCentsToVndCeiling(parseUsdCents(row.price_usd)!, limits.usdVndRate) ??
                 Number(row.price_vnd))
              : Number(row.price_vnd),
        }));
        return new Response(JSON.stringify({ data, usd_vnd_rate: limits.usdVndRate }), {
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
          // Cap binds before any provider call or row insert.
          const limits = await readPaymentLimits(db);
          if (!withinPaymentCap(bundle.price_vnd, limits.maxAmountVnd)) {
            return jsonError(400, "INVALID", "payment amount exceeds the configured maximum");
          }
          return createPayosPayment(params.id, userId, bundle.price_vnd, {
            bundleId: bundle.id,
          });
        }
        return createManualPurchase(params.id, userId, bundle.price_vnd, {
          bundleId: bundle.id,
        });
      },
    )
    .post(
      "/api/v1/workspaces/:id/subscription-plans/:planId/purchase",
      {
        params: t.Object({ id: t.String(), planId: t.String() }),
        body: t.Object({
          provider: t.Optional(t.Union([t.Literal("manual"), t.Literal("payos")])),
        }),
        detail: {
          tags: ["Billing"],
          summary: "Purchase a subscription plan",
          description:
            "Creates a pending payment at the server-side plan price; provider=payos returns a checkout_url. Credit is applied only on settlement (subscription wallet + active period).",
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
          .from(subscriptionPlans)
          .where(eq(subscriptionPlans.id, params.planId))
          .limit(1);
        const plan = rows[0];
        if (!plan) return jsonError(404, "NOT_FOUND", "Subscription plan not found");
        if (!plan.active) return jsonError(409, "INACTIVE", "Subscription plan is not available");
        const provider = (body as { provider?: string } | null)?.provider;
        if (provider === "payos") {
          if (!payos.available)
            return jsonError(503, "PROVIDER_UNAVAILABLE", "payOS is not configured");
          // Cap binds before any provider call or row insert.
          const limits = await readPaymentLimits(db);
          if (!withinPaymentCap(plan.price_vnd, limits.maxAmountVnd)) {
            return jsonError(400, "INVALID", "payment amount exceeds the configured maximum");
          }
          return createPayosPayment(params.id, userId, plan.price_vnd, {
            subscriptionPlanId: plan.id,
          });
        }
        return createManualPurchase(params.id, userId, plan.price_vnd, {
          subscriptionPlanId: plan.id,
        });
      },
    );
};
