CREATE TABLE "admin_wallet_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"wallet_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"delta" bigint NOT NULL,
	"reason" text NOT NULL,
	"balance_before" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"reserved" bigint NOT NULL,
	"ledger_entry_id" text,
	"request_payload" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "admin_wallet_adjustments_delta_type" CHECK ("admin_wallet_adjustments"."delta" != 0 AND "admin_wallet_adjustments"."delta" >= -9007199254740991 AND "admin_wallet_adjustments"."delta" <= 9007199254740991),
	CONSTRAINT "admin_wallet_adjustments_balance_before_type" CHECK ("admin_wallet_adjustments"."balance_before" >= 0 AND "admin_wallet_adjustments"."balance_before" <= 9007199254740991),
	CONSTRAINT "admin_wallet_adjustments_balance_after_type" CHECK ("admin_wallet_adjustments"."balance_after" >= 0 AND "admin_wallet_adjustments"."balance_after" <= 9007199254740991),
	CONSTRAINT "admin_wallet_adjustments_reserved_type" CHECK ("admin_wallet_adjustments"."reserved" >= 0 AND "admin_wallet_adjustments"."reserved" <= 9007199254740991),
	CONSTRAINT "admin_wallet_adjustments_created_at" CHECK ("admin_wallet_adjustments"."created_at" >= 0 AND "admin_wallet_adjustments"."created_at" <= 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "admin_wallet_adjustments" ADD CONSTRAINT "admin_wallet_adjustments_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_wallet_adjustments" ADD CONSTRAINT "admin_wallet_adjustments_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_wallet_adjustments" ADD CONSTRAINT "admin_wallet_adjustments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_wallet_adjustments" ADD CONSTRAINT "admin_wallet_adjustments_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_wallet_adjustments_actor_key_uq" ON "admin_wallet_adjustments" USING btree ("actor_user_id","idempotency_key");
