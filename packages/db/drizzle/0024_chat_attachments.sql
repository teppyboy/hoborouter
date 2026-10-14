CREATE TABLE "chat_attachments" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "workspace_id" text NOT NULL REFERENCES "workspaces"("id"),
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "mime" text NOT NULL,
  "bytes" bigint NOT NULL,
  "created_at" bigint NOT NULL,
  "expires_at" bigint NOT NULL,
  "deleted_at" bigint
);--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_kind" CHECK ("chat_attachments"."kind" IN ('image','text'));--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_bytes" CHECK ("chat_attachments"."bytes" > 0 AND "chat_attachments"."bytes" <= 10485760);--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_created_at" CHECK ("chat_attachments"."created_at" >= 0 AND "chat_attachments"."created_at" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_expires_at" CHECK ("chat_attachments"."expires_at" >= 0 AND "chat_attachments"."expires_at" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_deleted_at" CHECK ("chat_attachments"."deleted_at" IS NULL OR ("chat_attachments"."deleted_at" >= 0 AND "chat_attachments"."deleted_at" <= 9007199254740991));--> statement-breakpoint
CREATE INDEX "chat_attachments_user_live_idx" ON "chat_attachments" ("user_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "chat_attachments_workspace_created_idx" ON "chat_attachments" ("workspace_id", "created_at");--> statement-breakpoint
CREATE INDEX "chat_attachments_expires_idx" ON "chat_attachments" ("expires_at");
