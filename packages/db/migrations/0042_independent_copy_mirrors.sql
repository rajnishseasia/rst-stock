ALTER TABLE "copy_trade_follows" ADD COLUMN "stock_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "copy_trade_follows" ADD COLUMN "stock_auto_mirror" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_trade_follows" ADD COLUMN "stock_sizing_mode" text DEFAULT 'pct' NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_trade_follows" ADD COLUMN "stock_sizing_value" numeric(12, 2) DEFAULT '5' NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_trade_follows" ADD COLUMN "perp_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "copy_trade_follows" ADD COLUMN "perp_auto_mirror" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_trade_follows" ADD COLUMN "perp_sizing_mode" text DEFAULT 'pct' NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_trade_follows" ADD COLUMN "perp_sizing_value" numeric(12, 2) DEFAULT '5' NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_trade_follows" ADD COLUMN "destination_policy_initialized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "copy_trade_follows" ADD CONSTRAINT "copy_trade_follows_stock_credential_id_user_api_credentials_id_fk" FOREIGN KEY ("stock_credential_id") REFERENCES "public"."user_api_credentials"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "copy_trade_follows" ADD CONSTRAINT "copy_trade_follows_perp_credential_id_user_api_credentials_id_fk" FOREIGN KEY ("perp_credential_id") REFERENCES "public"."user_api_credentials"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Only copy a legacy destination when its account belongs to the follower,
-- matches the venue, is ready for that venue, and carries a valid size pair.
UPDATE "copy_trade_follows" AS follows
SET
	"stock_credential_id" = credentials.id,
	"stock_auto_mirror" = follows."auto_mirror",
	"stock_sizing_mode" = follows."sizing_mode",
	"stock_sizing_value" = follows."sizing_value"
FROM "user_api_credentials" AS credentials
WHERE follows."credential_id" = credentials.id
	AND credentials."user_id" = follows."follower_user_id"
	AND credentials.provider = 'alpaca'
	AND credentials.account_type IN ('PAPER', 'LIVE')
	AND (
		(follows."sizing_mode" = 'pct' AND follows."sizing_value" BETWEEN 0.01 AND 100) OR
		(follows."sizing_mode" = 'pct_equity' AND follows."sizing_value" BETWEEN 0.01 AND 100) OR
		(follows."sizing_mode" = 'usd' AND follows."sizing_value" BETWEEN 0.01 AND 1000000) OR
		(follows."sizing_mode" = 'ratio' AND follows."sizing_value" BETWEEN 0.01 AND 10)
	);
--> statement-breakpoint
UPDATE "copy_trade_follows" AS follows
SET
	"perp_credential_id" = credentials.id,
	"perp_auto_mirror" = follows."auto_mirror",
	"perp_sizing_mode" = follows."sizing_mode",
	"perp_sizing_value" = follows."sizing_value"
FROM "user_api_credentials" AS credentials
WHERE follows."credential_id" = credentials.id
	AND credentials."user_id" = follows."follower_user_id"
	AND credentials.provider = 'hyperliquid'
	AND credentials.account_type = 'LIVE'
	AND (
		(follows."sizing_mode" = 'pct' AND follows."sizing_value" BETWEEN 0.01 AND 100) OR
		(follows."sizing_mode" = 'pct_equity' AND follows."sizing_value" BETWEEN 0.01 AND 100) OR
		(follows."sizing_mode" = 'usd' AND follows."sizing_value" BETWEEN 0.01 AND 1000000) OR
		(follows."sizing_mode" = 'ratio' AND follows."sizing_value" BETWEEN 0.01 AND 10)
	);
--> statement-breakpoint
-- Rows that could not be safely backfilled are explicitly disarmed. This also
-- removes a foreign legacy credential so it cannot remain client-visible.
UPDATE "copy_trade_follows" AS follows
SET "auto_mirror" = false, "credential_id" = null
WHERE follows."auto_mirror" = true
	AND NOT EXISTS (
		SELECT 1
		FROM "user_api_credentials" AS credentials
		WHERE credentials.id = follows."credential_id"
			AND credentials."user_id" = follows."follower_user_id"
			AND (
				(credentials.provider = 'alpaca' AND credentials.account_type IN ('PAPER', 'LIVE')) OR
				(credentials.provider = 'hyperliquid' AND credentials.account_type = 'LIVE')
			)
			AND (
				(follows."sizing_mode" = 'pct' AND follows."sizing_value" BETWEEN 0.01 AND 100) OR
				(follows."sizing_mode" = 'pct_equity' AND follows."sizing_value" BETWEEN 0.01 AND 100) OR
				(follows."sizing_mode" = 'usd' AND follows."sizing_value" BETWEEN 0.01 AND 1000000) OR
				(follows."sizing_mode" = 'ratio' AND follows."sizing_value" BETWEEN 0.01 AND 10)
			)
	);
--> statement-breakpoint
UPDATE "copy_trade_follows" AS follows
SET "credential_id" = null
WHERE follows."credential_id" IS NOT NULL
	AND NOT EXISTS (
		SELECT 1
		FROM "user_api_credentials" AS credentials
		WHERE credentials.id = follows."credential_id"
			AND credentials."user_id" = follows."follower_user_id"
	);
--> statement-breakpoint
UPDATE "copy_trade_follows" SET "destination_policy_initialized" = true;
--> statement-breakpoint
ALTER TABLE "copy_trade_follows" ADD CONSTRAINT "copy_trade_follows_auto_mirror_valid_check" CHECK (
	"auto_mirror" = false OR (
		"credential_id" IS NOT NULL AND (
			("sizing_mode" = 'pct' AND "sizing_value" BETWEEN 0.01 AND 100) OR
			("sizing_mode" = 'pct_equity' AND "sizing_value" BETWEEN 0.01 AND 100) OR
			("sizing_mode" = 'usd' AND "sizing_value" BETWEEN 0.01 AND 1000000) OR
			("sizing_mode" = 'ratio' AND "sizing_value" BETWEEN 0.01 AND 10)
		)
	)
);--> statement-breakpoint
ALTER TABLE "copy_trade_follows" ADD CONSTRAINT "copy_trade_follows_stock_auto_mirror_valid_check" CHECK (
	"stock_auto_mirror" = false OR (
		"stock_credential_id" IS NOT NULL AND (
			("stock_sizing_mode" = 'pct' AND "stock_sizing_value" BETWEEN 0.01 AND 100) OR
			("stock_sizing_mode" = 'pct_equity' AND "stock_sizing_value" BETWEEN 0.01 AND 100) OR
			("stock_sizing_mode" = 'usd' AND "stock_sizing_value" BETWEEN 0.01 AND 1000000) OR
			("stock_sizing_mode" = 'ratio' AND "stock_sizing_value" BETWEEN 0.01 AND 10)
		)
	)
);--> statement-breakpoint
ALTER TABLE "copy_trade_follows" ADD CONSTRAINT "copy_trade_follows_perp_auto_mirror_valid_check" CHECK (
	"perp_auto_mirror" = false OR (
		"perp_credential_id" IS NOT NULL AND (
			("perp_sizing_mode" = 'pct' AND "perp_sizing_value" BETWEEN 0.01 AND 100) OR
			("perp_sizing_mode" = 'pct_equity' AND "perp_sizing_value" BETWEEN 0.01 AND 100) OR
			("perp_sizing_mode" = 'usd' AND "perp_sizing_value" BETWEEN 0.01 AND 1000000) OR
			("perp_sizing_mode" = 'ratio' AND "perp_sizing_value" BETWEEN 0.01 AND 10)
		)
	)
);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "manual_copy_source_item_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "manual_copy_source_order_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_trade_follows_stock_auto_mirror_created_at_id_idx" ON "copy_trade_follows" USING btree ("stock_auto_mirror",(date_trunc('milliseconds', "created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),"id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_trade_follows_perp_auto_mirror_created_at_id_idx" ON "copy_trade_follows" USING btree ("perp_auto_mirror",(date_trunc('milliseconds', "created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),"id");
