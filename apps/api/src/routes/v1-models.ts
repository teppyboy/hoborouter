// /v1/models — canonical catalog view (listPublicModels). Bearer sk-hbr- key
// auth preserved. OpenAI list shape: {object:'list', data:[{id: public_id,
// object:'model', created, owned_by: provider}]}. No CPA aliases, no legacy
// model_bindings. Each request queries the DB — no caching.
import { Elysia } from "elysia";
import type { Db } from "@hoborouter/db";
import { verifyApiKey } from "@hoborouter/keys";
import {
  listPublicModels,
  publicCapabilityFields,
  publicReasoningFields,
  resolveModel,
  type ModelRow,
} from "@hoborouter/catalog";
import { jsonError } from "../authz";

async function keyAuth(db: Db, request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return verifyApiKey(db, token); // null for missing/malformed/revoked keys
}

// OpenAI list shape plus the safe capability projection: supported_parameters,
// reasoning metadata (supported_efforts + default_effort, not a bare boolean),
// capabilities, context_window. Fields derive from stored catalog data only —
// no mapping/upstream/reasoning-route internals (see publicCapabilityFields and
// publicReasoningFields in @hoborouter/catalog).
const toOpenAiModel = async (db: Db, m: ModelRow) => ({
  id: m.public_id,
  object: "model" as const,
  created: Math.floor(m.created_at / 1000),
  owned_by: m.provider,
  ...publicCapabilityFields(m),
  reasoning: await publicReasoningFields(db, m.id),
});

export const v1ModelsRoutes = (db: Db) =>
  new Elysia({ name: "v1-models" })
    .get("/v1/models", async ({ request }) => {
      const key = await keyAuth(db, request);
      if (!key) return jsonError(401, "UNAUTHORIZED", "Valid Bearer sk-hbr- key required");
      return {
        object: "list",
        data: await Promise.all((await listPublicModels(db)).map((m) => toOpenAiModel(db, m))),
      };
    })
    .get("/v1/models/:id", async ({ request, params }) => {
      const key = await keyAuth(db, request);
      if (!key) return jsonError(401, "UNAUTHORIZED", "Valid Bearer sk-hbr- key required");
      const r = await resolveModel(db, params.id);
      if (!r) return jsonError(404, "NOT_FOUND", "Model not found");
      return toOpenAiModel(db, r.model);
    });
