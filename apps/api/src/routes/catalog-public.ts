// Public catalog routes for signed-in dashboard users: canonical model list
// with current prices. Published+enabled+mapped+priced models only; no markup,
// no upstream model names, no mapping ids. Uses @hoborouter/catalog helpers —
// no pricing logic here.
import { Elysia, t } from "elysia";
import type { Db } from "@hoborouter/db";import type { BetterAuthInstance } from "../auth-types";
import { requireSession, jsonError } from "../authz";
import {
  listPublicModels,
  resolveModel,
  getCurrentPrice,
  type ModelRow,
  type PriceRow,
} from "@hoborouter/catalog";

function parseCaps(v: unknown): string[] {
  return Array.isArray(v) && v.every((c) => typeof c === "string") ? (v as string[]) : [];
}

export const toCatalogItem = (model: ModelRow, price: PriceRow) => ({
  id: model.id,
  public_id: model.public_id,
  display_name: model.display_name,
  provider: model.provider,
  description: model.description,
  capabilities: parseCaps(model.capabilities),
  context_window: model.context_window,
  price: {
    input_usd_micro_per_1m: price.input_usd_micro_per_1m,
    output_usd_micro_per_1m: price.output_usd_micro_per_1m,
    cached_input_usd_micro_per_1m: price.cached_input_usd_micro_per_1m,
    reasoning_usd_micro_per_1m: price.reasoning_usd_micro_per_1m,
  },
});

export const catalogPublicRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "catalog-public" })
    .get(
      "/api/v1/catalog/models",
      {
        detail: {
          tags: ["Catalog"],
          summary: "List public models",
          description: "Canonical model list with current prices (session required).",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const rows = await listPublicModels(db);
        const data = await Promise.all(
          rows.map(async (m) => toCatalogItem(m, (await getCurrentPrice(db, m.id))!)),
        );
        return { data };
      },
    )
    .get(
      "/api/v1/catalog/models/:publicId",
      {
        params: t.Object({ publicId: t.String() }),
        detail: {
          tags: ["Catalog"],
          summary: "Get public model",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        // publicId may contain '/'; Elysia splits on '/' so rejoin all segments
        const publicId = Object.values(params).join("/");
        const found = await resolveModel(db, publicId);
        if (!found) return jsonError(404, "NOT_FOUND", "Model not found");
        return toCatalogItem(found.model, found.price);
      },
    );
