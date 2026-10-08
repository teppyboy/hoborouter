ALTER TABLE "api_keys" ADD COLUMN "purpose" text DEFAULT 'generic' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_purpose" CHECK ("api_keys"."purpose" IN ('generic','chat'));
