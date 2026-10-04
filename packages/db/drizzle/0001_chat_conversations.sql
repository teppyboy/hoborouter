CREATE TABLE "chat_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"model" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"archived_at" bigint,
	CONSTRAINT "chat_conversations_version" CHECK ("chat_conversations"."version" >= 1),
	CONSTRAINT "chat_conversations_created_at" CHECK ("chat_conversations"."created_at" >= 0 AND "chat_conversations"."created_at" <= 9007199254740991),
	CONSTRAINT "chat_conversations_updated_at" CHECK ("chat_conversations"."updated_at" >= 0 AND "chat_conversations"."updated_at" <= 9007199254740991),
	CONSTRAINT "chat_conversations_archived_at" CHECK ("chat_conversations"."archived_at" IS NULL OR "chat_conversations"."archived_at" >= 0 AND "chat_conversations"."archived_at" <= 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_conversations_list_idx" ON "chat_conversations" USING btree ("user_id","workspace_id","archived_at","updated_at","id");