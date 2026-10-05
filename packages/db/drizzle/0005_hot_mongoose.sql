CREATE TABLE "promo_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"name" text NOT NULL,
	"amount_vnd" bigint NOT NULL,
	"max_uses" integer NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "pc_amount_vnd" CHECK ("promo_codes"."amount_vnd" > 0 AND "promo_codes"."amount_vnd" <= 9007199254740991),
	CONSTRAINT "pc_max_uses" CHECK ("promo_codes"."max_uses" >= 1),
	CONSTRAINT "pc_uses" CHECK ("promo_codes"."uses" >= 0 AND "promo_codes"."uses" <= "promo_codes"."max_uses"),
	CONSTRAINT "pc_expires_at" CHECK ("promo_codes"."expires_at" IS NULL OR "promo_codes"."expires_at" >= 0 AND "promo_codes"."expires_at" <= 9007199254740991),
	CONSTRAINT "pc_created_at" CHECK ("promo_codes"."created_at" >= 0 AND "promo_codes"."created_at" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "promo_redemptions" (
	"id" text PRIMARY KEY NOT NULL,
	"promo_code_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"ledger_entry_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "pr_created_at" CHECK ("promo_redemptions"."created_at" >= 0 AND "promo_redemptions"."created_at" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "support_leads" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_email" text NOT NULL,
	"contact_channel" text,
	"workspace_id" text,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" bigint NOT NULL,
	"handled_at" bigint,
	"handled_by" text,
	CONSTRAINT "sl_status" CHECK ("support_leads"."status" IN ('open','handled')),
	CONSTRAINT "sl_created_at" CHECK ("support_leads"."created_at" >= 0 AND "support_leads"."created_at" <= 9007199254740991),
	CONSTRAINT "sl_handled_at" CHECK ("support_leads"."handled_at" IS NULL OR "support_leads"."handled_at" >= 0 AND "support_leads"."handled_at" <= 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "auto_eligible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_leads" ADD CONSTRAINT "support_leads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_leads" ADD CONSTRAINT "support_leads_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "promo_codes_code_hash" ON "promo_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_redemptions_code_workspace" ON "promo_redemptions" USING btree ("promo_code_id","workspace_id");