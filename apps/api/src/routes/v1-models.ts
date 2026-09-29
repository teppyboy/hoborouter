// Task 7: /v1/models — Bearer sk-hbr- key auth; published bindings visible to
// the key's workspace (workspace-specific ∪ global). CPA alias is NEVER present
// in any response body. Disabled bindings stop serving immediately (each request
// queries the DB — no cache beyond request lifetime).
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { verifyApiKey } from "@hoborouter/keys";
import { jsonError } from "../authz";

function keyAuth(db: Database, request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return verifyApiKey(db, token); // null for missing/malformed/revoked keys
}

export const v1ModelsRoutes = (db: Database) =>
  new Elysia({ name: "v1-models" })
    .get("/v1/models", ({ request }) => {
      const key = keyAuth(db, request);
      if (!key) return jsonError(401, "UNAUTHORIZED", "Valid Bearer sk-hbr- key required");
      return db
        .prepare(
          "SELECT id, public_model, price_input_per_1m, price_output_per_1m, effective_at FROM model_bindings WHERE status = 'published' AND (workspace_id IS NULL OR workspace_id = ?) ORDER BY public_model",
        )
        .all(key.workspace_id);
    })
    .get("/v1/models/:id", ({ request, params }) => {
      const key = keyAuth(db, request);
      if (!key) return jsonError(401, "UNAUTHORIZED", "Valid Bearer sk-hbr- key required");
      const row = db
        .prepare(
          "SELECT id, public_model, price_input_per_1m, price_output_per_1m, effective_at FROM model_bindings WHERE id = ? AND status = 'published' AND (workspace_id IS NULL OR workspace_id = ?)",
        )
        .get(params.id, key.workspace_id);
      if (!row) return jsonError(404, "NOT_FOUND", "Model not found");
      return row;
    });
