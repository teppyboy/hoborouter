// Task 7: published catalog — instance-admin CRUD (global scope, audit),
// member read-only workspace view. CPA alias is exposed ONLY here (admin
// console); it never appears in /v1 or workspace member responses.
import { Elysia, t } from "elysia";
import type { BetterAuthInstance } from "../auth-types";
import {
  requireSession,
  requireInstanceAdmin,
  requireWsRole,
  writeAudit,
  jsonError,
} from "../authz";
import { publishSnapshot } from "@hoborouter/catalog";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { type Db, modelBindings, priceSnapshots } from "@hoborouter/db";

async function latestSnapshots(db: Db) {
  // Latest snapshot per binding: ROW_NUMBER over (partition, created_at desc, id desc).
  const rn = sql<number>`row_number() over (partition by ${priceSnapshots.binding_id} order by ${priceSnapshots.created_at} desc, ${priceSnapshots.id} desc)`.as(
    "rn",
  );
  const ranked = db
    .select({
      binding_id: priceSnapshots.binding_id,
      id: priceSnapshots.id,
      price_input: priceSnapshots.price_input,
      price_output: priceSnapshots.price_output,
      created_at: priceSnapshots.created_at,
      rn,
    })
    .from(priceSnapshots)
    .as("ps");
  const rows = await db
    .select({
      binding_id: ranked.binding_id,
      id: ranked.id,
      price_input: ranked.price_input,
      price_output: ranked.price_output,
      created_at: ranked.created_at,
    })
    .from(ranked)
    .where(eq(ranked.rn, 1));
  return new Map(rows.map((s) => [s.binding_id, s]));
}

export const adminModelsRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "admin-models" })
    .get(
      "/api/v1/admin/models",
      {
        detail: {
          tags: ["Admin"],
          summary: "List model bindings",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireInstanceAdmin(db, gate.session.user.id);
        if (denied) return denied;
        const snaps = await latestSnapshots(db);
        const rows = await db
          .select({
            id: modelBindings.id,
            workspace_id: modelBindings.workspace_id,
            public_model: modelBindings.public_model,
            cpa_alias: modelBindings.cpa_alias,
            status: modelBindings.status,
            price_input_per_1m: modelBindings.price_input_per_1m,
            price_output_per_1m: modelBindings.price_output_per_1m,
            effective_at: modelBindings.effective_at,
          })
          .from(modelBindings)
          .orderBy(asc(modelBindings.public_model));
        return rows.map((r) => ({
          ...r,
          latest_snapshot: snaps.get(r.id) ?? null,
        }));
      },
    )
    .post(
      "/api/v1/admin/models",
      {
        body: t.Optional(t.Record(t.String(), t.Any())),
        detail: {
          tags: ["Admin"],
          summary: "Create model binding",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;
        const b = (body ?? {}) as Record<string, unknown>;
        const publicModel = typeof b.public_model === "string" ? b.public_model.trim() : "";
        const cpaAlias = typeof b.cpa_alias === "string" ? b.cpa_alias.trim() : "";
        const pin = b.price_input_per_1m;
        const pout = b.price_output_per_1m;
        if (
          !publicModel ||
          !cpaAlias ||
          typeof pin !== "number" ||
          !Number.isSafeInteger(pin) ||
          pin < 0 ||
          typeof pout !== "number" ||
          !Number.isSafeInteger(pout) ||
          pout < 0
        ) {
          return jsonError(
            400,
            "INVALID",
            "public_model, cpa_alias and non-negative integer VND prices are required",
          );
        }
        const id = crypto.randomUUID();
        const now = Date.now();
        await db.transaction(async (tx) => {
          await tx
            .insert(modelBindings)
            .values({
              id,
              workspace_id: null,
              public_model: publicModel,
              cpa_alias: cpaAlias,
              status: "published",
              price_input_per_1m: pin,
              price_output_per_1m: pout,
              effective_at: now,
            });
          await publishSnapshot(tx, { bindingId: id, priceInput: pin, priceOutput: pout, now });
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: null,
            action: "model.create",
            target: id,
            detail: { public_model: publicModel },
          });
        });
        return new Response(
          JSON.stringify({ id, public_model: publicModel, status: "published" }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      },
    )
    .put(
      "/api/v1/admin/models/:id",
      {
        params: t.Object({ id: t.String() }),
        body: t.Optional(t.Record(t.String(), t.Any())),
        detail: {
          tags: ["Admin"],
          summary: "Update model binding",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;
        const existing = await db
          .select({ id: modelBindings.id, status: modelBindings.status })
          .from(modelBindings)
          .where(eq(modelBindings.id, params.id))
          .limit(1);
        if (!existing[0]) return jsonError(404, "NOT_FOUND", "Model binding not found");
        const b = (body ?? {}) as Record<string, unknown>;
        const pin = b.price_input_per_1m;
        const pout = b.price_output_per_1m;
        const status = (b.status as string | undefined) ?? existing[0].status;
        if (
          typeof pin !== "number" ||
          !Number.isSafeInteger(pin) ||
          pin < 0 ||
          typeof pout !== "number" ||
          !Number.isSafeInteger(pout) ||
          pout < 0 ||
          (status !== "published" && status !== "disabled")
        ) {
          return jsonError(
            400,
            "INVALID",
            "non-negative integer VND prices and valid status required",
          );
        }
        const now = Date.now();
        await db.transaction(async (tx) => {
          await tx
            .update(modelBindings)
            .set({
              price_input_per_1m: pin,
              price_output_per_1m: pout,
              status: status as "published" | "disabled",
            })
            .where(eq(modelBindings.id, params.id));
          // A price change publishes a NEW immutable snapshot — never edits old rows.
          await publishSnapshot(tx, { bindingId: params.id, priceInput: pin, priceOutput: pout, now });
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: null,
            action: "model.update",
            target: params.id,
            detail: {
              price_input_per_1m: pin,
              price_output_per_1m: pout,
              status,
            },
          });
        });
        return new Response(JSON.stringify({ id: params.id, status }), {
          headers: { "content-type": "application/json" },
        });
      },
    )
    .get(
      "/api/v1/workspaces/:id/models",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Models"],
          summary: "List workspace models",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireWsRole(db, params.id, gate.session.user.id, "member");
        if (denied) return denied;
        // Read-only view: published bindings enabled for this workspace (own ∪ global).
        // No cpa_alias — aliases are never exposed outside the admin console.
        const snaps = await latestSnapshots(db);
        const rows = await db
          .select({
            id: modelBindings.id,
            public_model: modelBindings.public_model,
            status: modelBindings.status,
            price_input_per_1m: modelBindings.price_input_per_1m,
            price_output_per_1m: modelBindings.price_output_per_1m,
            effective_at: modelBindings.effective_at,
          })
          .from(modelBindings)
          .where(
            and(
              eq(modelBindings.status, "published"),
              or(isNull(modelBindings.workspace_id), eq(modelBindings.workspace_id, params.id)),
            ),
          )
          .orderBy(asc(modelBindings.public_model));
        return rows.map((r) => ({
          id: r.id,
          public_model: r.public_model,
          price_input_per_1m: r.price_input_per_1m,
          price_output_per_1m: r.price_output_per_1m,
          effective_at: r.effective_at,
          snapshot_id: snaps.get(r.id)?.id ?? null,
        }));
      },
    );
