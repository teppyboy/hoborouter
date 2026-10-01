// Public catalog routes for signed-in dashboard users: canonical model list
// with current prices. Published+enabled+mapped+priced models only; no markup,
// no upstream model names, no mapping ids. Uses @hoborouter/catalog helpers —
// no pricing logic here.
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, jsonError } from "../authz";
import {
  listPublicModels,
  resolveModel,
  getCurrentPrice,
  type ModelRow,
  type PriceRow,
} from "@hoborouter/catalog";

export const toCatalogItem = (model: ModelRow, price: PriceRow) => ({
  id: model.id,
  public_id: model.public_id,
  display_name: model.display_name,
  provider: model.provider,
  description: model.description,
  capabilities: model.capabilities ?? [],
  context_window: model.context_window,
  price: {
    input_usd_micro_per_1m: price.input_usd_micro_per_1m,
    output_usd_micro_per_1m: price.output_usd_micro_per_1m,
    cached_input_usd_micro_per_1m: price.cached_input_usd_micro_per_1m,
    reasoning_usd_micro_per_1m: price.reasoning_usd_micro_per_1m,
  },
});

export const catalogPublicRoutes = (db: Database, auth: BetterAuthInstance) =>
  new Elysia({ name: "catalog-public" })
    .get("/api/catalog/models", async ({ request }) => {
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const rows = listPublicModels(db);
      const data = rows.map((m) => toCatalogItem(m, getCurrentPrice(db, m.id)!));
      return { data };
    })
    .get("/api/catalog/models/:publicId", async ({ request, params }) => {
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      // publicId may contain '/'; Elysia splits on '/' so rejoin all segments
      const publicId = Object.values(params).join("/");
      const found = resolveModel(db, publicId);
      if (!found) return jsonError(404, "NOT_FOUND", "Model not found");
      return toCatalogItem(found.model, found.price);
    });
