-- USD catalog metadata (nullable text prices + creation FX snapshot).
-- Legacy VND rows keep every added column NULL and unchanged behavior.
ALTER TABLE "credit_bundles" ADD COLUMN "price_usd" text;--> statement-breakpoint
ALTER TABLE "credit_bundles" ADD COLUMN "credit_usd" text;--> statement-breakpoint
ALTER TABLE "credit_bundles" ADD COLUMN "bonus_usd" text;--> statement-breakpoint
ALTER TABLE "credit_bundles" ADD COLUMN "creation_fx_rate_vnd_per_usd" bigint;--> statement-breakpoint
-- A bundle is either fully legacy VND or fully USD-authored: all four USD
-- columns NULL, or all four set (group keyed on price_usd).
ALTER TABLE "credit_bundles" ADD CONSTRAINT "cb_usd_group_complete" CHECK (
  (price_usd IS NULL) = (credit_usd IS NULL)
    AND (price_usd IS NULL) = (bonus_usd IS NULL)
    AND (price_usd IS NULL) = (creation_fx_rate_vnd_per_usd IS NULL)
);--> statement-breakpoint
-- USD text: unsigned plain decimal with at most two fractional digits. The
-- format check runs before the numeric cast so the cast never sees invalid
-- text; leading zeros are tolerated at the DB layer and normalized by the API.
ALTER TABLE "credit_bundles" ADD CONSTRAINT "cb_price_usd_format" CHECK (
  price_usd IS NULL OR (
    price_usd ~ '^[0-9]+(\.[0-9]{1,2})?$'
    AND price_usd::numeric > 0
    AND price_usd::numeric <= 9007199254740991
  )
);--> statement-breakpoint
ALTER TABLE "credit_bundles" ADD CONSTRAINT "cb_credit_usd_format" CHECK (
  credit_usd IS NULL OR (
    credit_usd ~ '^[0-9]+(\.[0-9]{1,2})?$'
    AND credit_usd::numeric >= 0
    AND credit_usd::numeric <= 9007199254740991
  )
);--> statement-breakpoint
ALTER TABLE "credit_bundles" ADD CONSTRAINT "cb_bonus_usd_format" CHECK (
  bonus_usd IS NULL OR (
    bonus_usd ~ '^[0-9]+(\.[0-9]{1,2})?$'
    AND bonus_usd::numeric >= 0
    AND bonus_usd::numeric <= 9007199254740991
  )
);--> statement-breakpoint
ALTER TABLE "credit_bundles" ADD CONSTRAINT "cb_creation_fx_rate_vnd_per_usd" CHECK (
  creation_fx_rate_vnd_per_usd IS NULL
    OR (creation_fx_rate_vnd_per_usd > 0 AND creation_fx_rate_vnd_per_usd <= 9007199254740991)
);--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "price_usd" text;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "credit_per_period_usd" text;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "creation_fx_rate_vnd_per_usd" bigint;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "sp_usd_group_complete" CHECK (
  (price_usd IS NULL) = (credit_per_period_usd IS NULL)
    AND (price_usd IS NULL) = (creation_fx_rate_vnd_per_usd IS NULL)
);--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "sp_price_usd_format" CHECK (
  price_usd IS NULL OR (
    price_usd ~ '^[0-9]+(\.[0-9]{1,2})?$'
    AND price_usd::numeric > 0
    AND price_usd::numeric <= 9007199254740991
  )
);--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "sp_credit_per_period_usd_format" CHECK (
  credit_per_period_usd IS NULL OR (
    credit_per_period_usd ~ '^[0-9]+(\.[0-9]{1,2})?$'
    AND credit_per_period_usd::numeric >= 0
    AND credit_per_period_usd::numeric <= 9007199254740991
  )
);--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "sp_creation_fx_rate_vnd_per_usd" CHECK (
  creation_fx_rate_vnd_per_usd IS NULL
    OR (creation_fx_rate_vnd_per_usd > 0 AND creation_fx_rate_vnd_per_usd <= 9007199254740991)
);
