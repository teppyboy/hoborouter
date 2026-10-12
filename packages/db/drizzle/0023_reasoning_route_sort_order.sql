ALTER TABLE "model_reasoning_routes" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill: contiguous per-model order following the pre-sort_order catalog
-- read order (created_at, id) so existing routes keep their public projection.
UPDATE "model_reasoning_routes" SET "sort_order" = sub.rn - 1 FROM (
	SELECT "id", ROW_NUMBER() OVER (PARTITION BY "model_id" ORDER BY "created_at", "id") AS rn
	FROM "model_reasoning_routes"
) sub WHERE "model_reasoning_routes"."id" = sub."id";
