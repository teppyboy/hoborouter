ALTER TABLE "payments" ADD COLUMN "input_currency" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "input_amount_text" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "fx_rate_vnd_per_usd" bigint;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_fx_rate_positive" CHECK ("payments"."fx_rate_vnd_per_usd" IS NULL OR "payments"."fx_rate_vnd_per_usd" > 0);
