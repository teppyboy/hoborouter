ALTER TABLE "subscriptions" ADD COLUMN "canceled_at" bigint;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_canceled_at" CHECK ("subscriptions"."canceled_at" IS NULL OR ("subscriptions"."canceled_at" >= 0 AND "subscriptions"."canceled_at" <= 9007199254740991));
