// Instance-admin CRUD for credit bundles and subscription plans. No delete:
// catalog items are deactivated (active=false); past payments keep their FK.
// Amounts are immutable after create — settlement reads them at payment
// success time, so editing a price would silently change what pending
// payments credit; a price change means deactivate + create a new item.
import { Elysia, t } from "elysia";
import type { Db } from "@hoborouter/db";
import { creditBundles, subscriptionPlans } from "@hoborouter/db";
import { desc, eq } from "drizzle-orm";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, writeAudit, jsonError } from "../authz";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const posInt = (v: number) => Number.isSafeInteger(v) && v > 0;
const nonNegInt = (v: number) => Number.isSafeInteger(v) && v >= 0;
// Mirrors the subscription_plans rate_limit CHECK; not a money amount, so it
// stays PATCH-editable on existing plans.
const validRateLimit = (v: number) => Number.isSafeInteger(v) && v >= 1 && v <= 600;

export const adminBundlesRoutes = (db: Db, auth: BetterAuthInstance) => {
  const guard = async (request: Request) => {
    const gate = await requireSession(auth, request);
    if ("error" in gate) return { error: gate.error } as const;
    const denied = await requireInstanceAdmin(db, gate.session.user.id);
    if (denied) return { error: denied } as const;
    return { userId: gate.session.user.id } as const;
  };

  const bundleRoutes = new Elysia({ name: "admin-bundles" })
    .get(
      "/api/v1/admin/bundles",
      {
        detail: { tags: ["Admin"], summary: "List credit bundles", security: [{ cookieAuth: [] }] },
      },
      async ({ request }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        const rows = await db.select().from(creditBundles).orderBy(desc(creditBundles.created_at));
        return json({ data: rows });
      },
    )
    .post(
      "/api/v1/admin/bundles",
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          price_vnd: t.Integer(),
          credit_vnd: t.Integer(),
          bonus_vnd: t.Optional(t.Integer()),
        }),
        detail: {
          tags: ["Admin"],
          summary: "Create credit bundle",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        if (!posInt(body.price_vnd))
          return jsonError(400, "INVALID", "price_vnd must be a positive integer VND amount");
        if (!nonNegInt(body.credit_vnd) || !nonNegInt(body.bonus_vnd ?? 0))
          return jsonError(400, "INVALID", "credit_vnd and bonus_vnd must be non-negative integers");
        const id = crypto.randomUUID();
        const row = {
          id,
          name: body.name,
          price_vnd: body.price_vnd,
          credit_vnd: body.credit_vnd,
          bonus_vnd: body.bonus_vnd ?? 0,
          active: true,
          created_at: Date.now(),
        };
        await db.transaction(async (tx) => {
          await tx.insert(creditBundles).values(row);
          await writeAudit(tx, {
            actorUserId: g.userId,
            workspaceId: null,
            action: "bundle.create",
            target: id,
            detail: row,
          });
        });
        return json(row, 201);
      },
    )
    .patch(
      "/api/v1/admin/bundles/:id",
      {
        params: t.Object({ id: t.String() }),
        // additionalProperties:false enforces the immutable-amounts rule at the
        // boundary: price/credit edits are rejected, not silently ignored.
        body: t.Object(
          { name: t.Optional(t.String({ minLength: 1 })), active: t.Optional(t.Boolean()) },
          { additionalProperties: false },
        ),
        detail: {
          tags: ["Admin"],
          summary: "Update bundle name/active (amounts immutable)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        const rows = await db
          .select()
          .from(creditBundles)
          .where(eq(creditBundles.id, params.id))
          .limit(1);
        if (!rows[0]) return jsonError(404, "NOT_FOUND", "Bundle not found");
        const before = rows[0];
        const set: { name?: string; active?: boolean } = {};
        if (body.name !== undefined) set.name = body.name;
        if (body.active !== undefined) set.active = body.active;
        if (Object.keys(set).length === 0) return json(before);
        const after = { ...before, ...set };
        await db.transaction(async (tx) => {
          await tx.update(creditBundles).set(set).where(eq(creditBundles.id, params.id));
          await writeAudit(tx, {
            actorUserId: g.userId,
            workspaceId: null,
            action: "bundle.update",
            target: params.id,
            detail: { before, after },
          });
        });
        return json(after);
      },
    );

  const planRoutes = new Elysia({ name: "admin-subscription-plans" })
    .get(
      "/api/v1/admin/subscription-plans",
      {
        detail: {
          tags: ["Admin"],
          summary: "List subscription plans",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        const rows = await db
          .select()
          .from(subscriptionPlans)
          .orderBy(desc(subscriptionPlans.created_at));
        return json({ data: rows });
      },
    )
    .post(
      "/api/v1/admin/subscription-plans",
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          price_vnd: t.Integer(),
          credit_per_period_vnd: t.Integer(),
          period_days: t.Optional(t.Integer()),
          rate_limit_per_minute: t.Optional(t.Integer()),
        }),
        detail: {
          tags: ["Admin"],
          summary: "Create subscription plan",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        if (!posInt(body.price_vnd))
          return jsonError(400, "INVALID", "price_vnd must be a positive integer VND amount");
        if (!nonNegInt(body.credit_per_period_vnd))
          return jsonError(400, "INVALID", "credit_per_period_vnd must be a non-negative integer");
        if (body.period_days !== undefined && !(body.period_days >= 1))
          return jsonError(400, "INVALID", "period_days must be >= 1");
        if (body.rate_limit_per_minute !== undefined && !validRateLimit(body.rate_limit_per_minute))
          return jsonError(400, "INVALID", "rate_limit_per_minute must be an integer between 1 and 600");
        const id = crypto.randomUUID();
        const row = {
          id,
          name: body.name,
          price_vnd: body.price_vnd,
          credit_per_period_vnd: body.credit_per_period_vnd,
          period_days: body.period_days ?? 30,
          rate_limit_per_minute: body.rate_limit_per_minute ?? 15,
          active: true,
          created_at: Date.now(),
        };
        await db.transaction(async (tx) => {
          await tx.insert(subscriptionPlans).values(row);
          await writeAudit(tx, {
            actorUserId: g.userId,
            workspaceId: null,
            action: "plan.create",
            target: id,
            detail: row,
          });
        });
        return json(row, 201);
      },
    )
    .patch(
      "/api/v1/admin/subscription-plans/:id",
      {
        params: t.Object({ id: t.String() }),
        body: t.Object(
          {
            name: t.Optional(t.String({ minLength: 1 })),
            active: t.Optional(t.Boolean()),
            rate_limit_per_minute: t.Optional(t.Integer()),
          },
          { additionalProperties: false },
        ),
        detail: {
          tags: ["Admin"],
          summary: "Update plan name/active/rate limit (amounts immutable)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        const rows = await db
          .select()
          .from(subscriptionPlans)
          .where(eq(subscriptionPlans.id, params.id))
          .limit(1);
        if (!rows[0]) return jsonError(404, "NOT_FOUND", "Plan not found");
        const before = rows[0];
        const set: { name?: string; active?: boolean; rate_limit_per_minute?: number } = {};
        if (body.name !== undefined) set.name = body.name;
        if (body.active !== undefined) set.active = body.active;
        if (body.rate_limit_per_minute !== undefined) {
          if (!validRateLimit(body.rate_limit_per_minute))
            return jsonError(400, "INVALID", "rate_limit_per_minute must be an integer between 1 and 600");
          set.rate_limit_per_minute = body.rate_limit_per_minute;
        }
        if (Object.keys(set).length === 0) return json(before);
        const after = { ...before, ...set };
        await db.transaction(async (tx) => {
          await tx.update(subscriptionPlans).set(set).where(eq(subscriptionPlans.id, params.id));
          await writeAudit(tx, {
            actorUserId: g.userId,
            workspaceId: null,
            action: "plan.update",
            target: params.id,
            detail: { before, after },
          });
        });
        return json(after);
      },
    );

  // Composed plugin: .use keeps each route group's handlers intact without
  // cross-group chaining (Elysia route builders cannot be .concat'd).
  return new Elysia({ name: "admin-bundles" }).use(bundleRoutes).use(planRoutes);
};
