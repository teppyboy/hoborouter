// Task 7: published catalog — instance-admin CRUD (global scope, audit),
// member read-only workspace view. CPA alias is exposed ONLY here (admin
// console); it never appears in /v1 or workspace member responses.
import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import {
  requireSession,
  requireInstanceAdmin,
  requireWsRole,
  writeAudit,
  jsonError,
} from "../authz";
import { publishSnapshot } from "@hoborouter/catalog";

function latestSnapshots(db: Database) {
  return new Map(
    (
      db
        .prepare(
          "SELECT * FROM (SELECT ps.*, ROW_NUMBER() OVER (PARTITION BY binding_id ORDER BY created_at DESC, id DESC) rn FROM price_snapshots ps) WHERE rn = 1",
        )
        .all() as {
        binding_id: string;
        id: string;
        price_input: number;
        price_output: number;
        created_at: number;
      }[]
    ).map((s) => [s.binding_id, s]),
  );
}

export const adminModelsRoutes = (db: Database, auth: BetterAuthInstance) =>
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
        const denied = requireInstanceAdmin(db, gate.session.user.id);
        if (denied) return denied;
        const snaps = latestSnapshots(db);
        const rows = db
          .prepare(
            "SELECT id, workspace_id, public_model, cpa_alias, status, price_input_per_1m, price_output_per_1m, effective_at FROM model_bindings ORDER BY public_model",
          )
          .all() as Record<string, unknown>[];
        return rows.map((r) => ({
          ...r,
          latest_snapshot: snaps.get(r.id as string) ?? null,
        }));
      },
    )
    .post(
      "/api/v1/admin/models",
      {
        body: t.Optional(t.Object({})),
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
        const denied = requireInstanceAdmin(db, userId);
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
        db.transaction(() => {
          db.prepare(
            "INSERT INTO model_bindings (id, workspace_id, public_model, cpa_alias, status, price_input_per_1m, price_output_per_1m, effective_at) VALUES (?,NULL,?,?,'published',?,?,?)",
          ).run(id, publicModel, cpaAlias, pin, pout, now);
          publishSnapshot(db, { bindingId: id, priceInput: pin, priceOutput: pout, now });
          writeAudit(db, {
            actorUserId: userId,
            workspaceId: null,
            action: "model.create",
            target: id,
            detail: { public_model: publicModel },
          });
        })();
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
        body: t.Optional(t.Object({})),
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
        const denied = requireInstanceAdmin(db, userId);
        if (denied) return denied;
        const existing = db
          .prepare("SELECT id, status FROM model_bindings WHERE id = ?")
          .get(params.id) as { id: string; status: string } | undefined;
        if (!existing) return jsonError(404, "NOT_FOUND", "Model binding not found");
        const b = (body ?? {}) as Record<string, unknown>;
        const pin = b.price_input_per_1m;
        const pout = b.price_output_per_1m;
        const status = (b.status as string | undefined) ?? existing.status;
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
        db.transaction(() => {
          db.prepare(
            "UPDATE model_bindings SET price_input_per_1m = ?, price_output_per_1m = ?, status = ? WHERE id = ?",
          ).run(pin, pout, status, params.id);
          // A price change publishes a NEW immutable snapshot — never edits old rows.
          publishSnapshot(db, { bindingId: params.id, priceInput: pin, priceOutput: pout, now });
          writeAudit(db, {
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
        })();
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
        const denied = requireWsRole(db, params.id, gate.session.user.id, "member");
        if (denied) return denied;
        // Read-only view: published bindings enabled for this workspace (own ∪ global).
        // No cpa_alias — aliases are never exposed outside the admin console.
        const snaps = latestSnapshots(db);
        const rows = db
          .prepare(
            "SELECT id, public_model, status, price_input_per_1m, price_output_per_1m, effective_at FROM model_bindings WHERE status = 'published' AND (workspace_id IS NULL OR workspace_id = ?) ORDER BY public_model",
          )
          .all(params.id) as Record<string, unknown>[];
        return rows.map((r) => ({
          id: r.id,
          public_model: r.public_model,
          price_input_per_1m: r.price_input_per_1m,
          price_output_per_1m: r.price_output_per_1m,
          effective_at: r.effective_at,
          snapshot_id: snaps.get(r.id as string)?.id ?? null,
        }));
      },
    );
