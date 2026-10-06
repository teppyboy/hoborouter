ALTER TABLE "api_keys" ADD COLUMN "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "deleted_by" text;
