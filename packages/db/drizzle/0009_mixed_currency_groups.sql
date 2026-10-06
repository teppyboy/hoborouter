-- Mixed per-field currency groups (supervisor-approved contract): each USD
-- field is authored independently; the shared creation FX snapshot is required
-- whenever ANY USD field is set. Existing all-or-nothing USD rows and legacy
-- all-VND rows still satisfy the relaxed constraint, so no data is rewritten.
ALTER TABLE "credit_bundles" DROP CONSTRAINT "cb_usd_group_complete";--> statement-breakpoint
ALTER TABLE "credit_bundles" ADD CONSTRAINT "cb_usd_group_complete" CHECK (
  (creation_fx_rate_vnd_per_usd IS NOT NULL)
    = (price_usd IS NOT NULL OR credit_usd IS NOT NULL OR bonus_usd IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "subscription_plans" DROP CONSTRAINT "sp_usd_group_complete";--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "sp_usd_group_complete" CHECK (
  (creation_fx_rate_vnd_per_usd IS NOT NULL)
    = (price_usd IS NOT NULL OR credit_per_period_usd IS NOT NULL)
);
