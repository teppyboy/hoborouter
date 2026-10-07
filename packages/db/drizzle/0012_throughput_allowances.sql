CREATE TABLE "throughput_products" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price_vnd" bigint NOT NULL,
	"requests_per_minute" integer NOT NULL,
	"duration_days" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "tp_price_vnd" CHECK ("throughput_products"."price_vnd" > 0 AND "throughput_products"."price_vnd" <= 9007199254740991),
	CONSTRAINT "tp_requests_per_minute" CHECK ("throughput_products"."requests_per_minute" >= 1 AND "throughput_products"."requests_per_minute" <= 600),
	CONSTRAINT "tp_duration_days" CHECK ("throughput_products"."duration_days" >= 1 AND "throughput_products"."duration_days" <= 3650),
	CONSTRAINT "tp_created_at" CHECK ("throughput_products"."created_at" >= 0 AND "throughput_products"."created_at" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "throughput_allowances" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"product_id" text NOT NULL,
	"requests_per_minute" integer NOT NULL,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "throughput_allowances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "throughput_allowances_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "throughput_allowances_product_id_throughput_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."throughput_products"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "ta_requests_per_minute" CHECK ("throughput_allowances"."requests_per_minute" >= 1 AND "throughput_allowances"."requests_per_minute" <= 600),
	CONSTRAINT "ta_window" CHECK ("throughput_allowances"."starts_at" < "throughput_allowances"."ends_at"),
	CONSTRAINT "ta_starts_at" CHECK ("throughput_allowances"."starts_at" >= 0 AND "throughput_allowances"."starts_at" <= 9007199254740991),
	CONSTRAINT "ta_ends_at" CHECK ("throughput_allowances"."ends_at" >= 0 AND "throughput_allowances"."ends_at" <= 9007199254740991),
	CONSTRAINT "ta_status" CHECK ("throughput_allowances"."status" IN ('scheduled','active','expired','deactivated')),
	CONSTRAINT "ta_created_at" CHECK ("throughput_allowances"."created_at" >= 0 AND "throughput_allowances"."created_at" <= 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "throughput_allowances_one_active_per_workspace" ON "throughput_allowances" USING btree ("workspace_id") WHERE status = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX "throughput_allowances_one_start_per_workspace" ON "throughput_allowances" USING btree ("workspace_id","starts_at");
--> statement-breakpoint
CREATE INDEX "throughput_allowances_workspace_status_idx" ON "throughput_allowances" USING btree ("workspace_id","status");
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "throughput_product_id" text;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_throughput_product_id_throughput_products_id_fk" FOREIGN KEY ("throughput_product_id") REFERENCES "public"."throughput_products"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_one_purchase_kind";
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_one_purchase_kind" CHECK ((CASE WHEN "payments"."bundle_id" IS NULL THEN 1 ELSE 0 END + CASE WHEN "payments"."subscription_plan_id" IS NULL THEN 1 ELSE 0 END + CASE WHEN "payments"."throughput_product_id" IS NULL THEN 1 ELSE 0 END) >= 2);
