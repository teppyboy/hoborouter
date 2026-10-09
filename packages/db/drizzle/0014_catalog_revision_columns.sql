ALTER TABLE "credit_bundles" ADD COLUMN "revision_key" text;--> statement-breakpoint
ALTER TABLE "credit_bundles" ADD COLUMN "successor_id" text;--> statement-breakpoint
ALTER TABLE "credit_bundles" ADD CONSTRAINT "credit_bundles_successor_id_credit_bundles_id_fk" FOREIGN KEY ("successor_id") REFERENCES "public"."credit_bundles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cb_revision_key_uq" ON "credit_bundles" USING btree ("revision_key") WHERE revision_key IS NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "revision_key" text;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "successor_id" text;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_successor_id_subscription_plans_id_fk" FOREIGN KEY ("successor_id") REFERENCES "public"."subscription_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sp_revision_key_uq" ON "subscription_plans" USING btree ("revision_key") WHERE revision_key IS NOT NULL;
