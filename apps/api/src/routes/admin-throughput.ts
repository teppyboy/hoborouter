// Instance-admin CRUD for prepaid throughput allowance products. No delete:
// catalog items are deactivated (active=false); past payments keep their FK.
// Amounts are immutable after create — settlement reads them at payment
// success time, so editing a price would silently change what pending
// payments activate; a price change means deactivate + create a new item.
// VND-only authoring: the allowance product charges integer VND and grants
// NO credit, so there is no USD group and no FX snapshot to manage.
import { Elysia, t } from "elysia";
import type { Db } from "@hoborouter/db";
import { throughputProducts } from "@hoborouter/db";
import { desc, eq } from "drizzle-orm";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, writeAudit, jsonError } from "../authz";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const posInt = (v: number | undefined): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
// Mirrors the subscription_plans rate_limit CHECK; a gateway admission bound,
// not a money amount.
const validRpm = (v: number) => Number.isSafeInteger(v) && v >= 1 && v <= 600;
const validDurationDays = (v: number) => Number.isSafeInteger(v) && v >= 1 && v <= 3650;

export const adminThroughputRoutes = (db: Db, auth: BetterAuthInstance) => {
  const guard = async (request: Request) => {
    const gate = await requireSession(auth, request);
    if ("error" in gate) return { error: gate.error } as const;
    const denied = await requireInstanceAdmin(db, gate.session.user.id);
    if (denied) return { error: denied } as const;
    return { userId: gate.session.user.id } as const;
  };

  return new Elysia({ name: "admin-throughput" })
    .get(
      "/api/v1/admin/throughput-products",
      {
        detail: {
          tags: ["Admin"],
          summary: "List throughput products",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        const rows = await db
          .select()
          .from(throughputProducts)
          .orderBy(desc(throughputProducts.created_at));
        return json({ data: rows });
      },
    )
    .post(
      "/api/v1/admin/throughput-products",
      {
        body: t.Object({
          name: t.String({ minLength: 1, maxLength: 200 }),
          price_vnd: t.Number(),
          requests_per_minute: t.Number(),
          duration_days: t.Number(),
        }),
        detail: {
          tags: ["Admin"],
          summary: "Create a throughput product",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        if (!posInt(body.price_vnd))
          return jsonError(400, "INVALID", "price_vnd must be a positive integer VND amount");
        if (!validRpm(body.requests_per_minute))
          return jsonError(
            400,
            "INVALID",
            "requests_per_minute must be an integer between 1 and 600",
          );
        if (!validDurationDays(body.duration_days))
          return jsonError(400, "INVALID", "duration_days must be an integer between 1 and 3650");
        const id = crypto.randomUUID();
        const row = {
          id,
          name: body.name,
          price_vnd: body.price_vnd,
          requests_per_minute: body.requests_per_minute,
          duration_days: body.duration_days,
          active: true,
          created_at: Date.now(),
        };
        await db.transaction(async (tx) => {
          await tx.insert(throughputProducts).values(row);
          await writeAudit(tx, {
            actorUserId: g.userId,
            workspaceId: null,
            action: "throughput_product.create",
            target: id,
            detail: row,
          });
        });
        return json(row, 201);
      },
    )
    .post(
      "/api/v1/admin/throughput-products/:id/deactivate",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Admin"],
          summary: "Deactivate a throughput product",
          description:
            "Deactivation stops new purchases; existing allowances keep their window until it lapses or an admin deactivates them.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        const rows = await db
          .select({ id: throughputProducts.id, active: throughputProducts.active })
          .from(throughputProducts)
          .where(eq(throughputProducts.id, params.id))
          .limit(1);
        if (!rows[0]) return jsonError(404, "NOT_FOUND", "Throughput product not found");
        if (rows[0].active) {
          await db.transaction(async (tx) => {
            await tx
              .update(throughputProducts)
              .set({ active: false })
              .where(eq(throughputProducts.id, params.id));
            await writeAudit(tx, {
              actorUserId: g.userId,
              workspaceId: null,
              action: "throughput_product.deactivate",
              target: params.id,
              detail: { active: false },
            });
          });
        }
        return json({ id: params.id, active: false });
      },
    );
};
