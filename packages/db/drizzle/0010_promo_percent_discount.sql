ALTER TABLE "promo_codes" ADD COLUMN "kind" text NOT NULL DEFAULT 'fixed';--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "percent_bp" integer;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "max_discount_vnd" bigint;--> statement-breakpoint
ALTER TABLE "promo_codes" ALTER COLUMN "amount_vnd" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_codes" DROP CONSTRAINT "pc_amount_vnd";--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "pc_amount_vnd" CHECK ("promo_codes"."amount_vnd" IS NULL OR ("promo_codes"."amount_vnd" > 0 AND "promo_codes"."amount_vnd" <= 9007199254740991));--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "pc_kind" CHECK (("promo_codes"."kind" = 'fixed' AND "promo_codes"."amount_vnd" IS NOT NULL AND "promo_codes"."percent_bp" IS NULL AND "promo_codes"."max_discount_vnd" IS NULL) OR ("promo_codes"."kind" = 'percent' AND "promo_codes"."amount_vnd" IS NULL AND "promo_codes"."percent_bp" > 0 AND "promo_codes"."percent_bp" <= 9999 AND "promo_codes"."max_discount_vnd" > 0 AND "promo_codes"."max_discount_vnd" <= 9007199254740991));--> statement-breakpoint
ALTER TABLE "promo_redemptions" ALTER COLUMN "ledger_entry_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD COLUMN "payment_id" text;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "pr_one_gate" CHECK (("promo_redemptions"."ledger_entry_id" IS NULL) <> ("promo_redemptions"."payment_id" IS NULL));--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "promo_code_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "promo_kind" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "original_amount_vnd" bigint;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "discount_vnd" bigint;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voucher_snapshot" CHECK (("payments"."promo_code_id" IS NULL AND "payments"."promo_kind" IS NULL AND "payments"."original_amount_vnd" IS NULL AND "payments"."discount_vnd" IS NULL) OR ("payments"."promo_code_id" IS NOT NULL AND "payments"."promo_kind" IS NOT NULL AND "payments"."original_amount_vnd" > 0 AND "payments"."original_amount_vnd" <= 9007199254740991 AND "payments"."discount_vnd" >= 0 AND "payments"."discount_vnd" <= 9007199254740991));
