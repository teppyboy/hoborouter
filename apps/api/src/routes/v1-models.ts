// /v1/models — canonical catalog view (listPublicModels). Bearer sk-hbr- key
// auth preserved. OpenAI list shape: {object:'list', data:[{id: public_id,
// object:'model', created, owned_by: provider}]}. No CPA aliases, no legacy
// model_bindings. Each request queries the DB — no caching.
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { verifyApiKey } from "@hoborouter/keys";
import { listPublicModels, resolveModel } from "@hoborouter/catalog";
import { jsonError } from "../authz";

function keyAuth(db: Database, request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return verifyApiKey(db, token); // null for missing/malformed/revoked keys
}

const toOpenAiModel = (m: { public_id: string; provider: string; created_at: number }) => ({
  id: m.public_id,
  object: "model" as const,
  created: Math.floor(m.created_at / 1000),
  owned_by: m.provider,
});

export const v1ModelsRoutes = (db: Database) =>
  new Elysia({ name: "v1-models" })
    .get("/v1/models", ({ request }) => {
      const key = keyAuth(db, request);
      if (!key) return jsonError(401, "UNAUTHORIZED", "Valid Bearer sk-hbr- key required");
      return {
        object: "list",
        data: listPublicModels(db).map(toOpenAiModel),
      };
    })
    .get("/v1/models/:id", ({ request, params }) => {
      const key = keyAuth(db, request);
      if (!key) return jsonError(401, "UNAUTHORIZED", "Valid Bearer sk-hbr- key required");
      const r = resolveModel(db, params.id);
      if (!r) return jsonError(404, "NOT_FOUND", "Model not found");
      return toOpenAiModel(r.model);
    });
