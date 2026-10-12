ALTER TABLE "models" ADD COLUMN "default_reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_default_reasoning_effort" CHECK ("models"."default_reasoning_effort" IS NULL OR "models"."default_reasoning_effort" IN ('none','minimal','low','medium','high','xhigh','max'));--> statement-breakpoint
CREATE TABLE "model_reasoning_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"public_effort" text NOT NULL,
	"provider" text NOT NULL,
	"upstream_model" text NOT NULL,
	"upstream_effort" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);--> statement-breakpoint
ALTER TABLE "model_reasoning_routes" ADD CONSTRAINT "model_reasoning_routes_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "model_reasoning_routes" ADD CONSTRAINT "mrr_public_effort" CHECK ("model_reasoning_routes"."public_effort" IN ('none','minimal','low','medium','high','xhigh','max'));--> statement-breakpoint
ALTER TABLE "model_reasoning_routes" ADD CONSTRAINT "mrr_upstream_effort" CHECK ("model_reasoning_routes"."upstream_effort" IN ('none','minimal','low','medium','high','xhigh','max'));--> statement-breakpoint
ALTER TABLE "model_reasoning_routes" ADD CONSTRAINT "mrr_created_at" CHECK ("model_reasoning_routes"."created_at" >= 0 AND "model_reasoning_routes"."created_at" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "model_reasoning_routes" ADD CONSTRAINT "mrr_updated_at" CHECK ("model_reasoning_routes"."updated_at" >= 0 AND "model_reasoning_routes"."updated_at" <= 9007199254740991);--> statement-breakpoint
CREATE UNIQUE INDEX "model_reasoning_routes_one_enabled_per_effort" ON "model_reasoning_routes" USING btree ("model_id","public_effort") WHERE enabled = true;
