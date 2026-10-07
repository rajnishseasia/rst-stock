ALTER TABLE "copy_trade_follows" ADD COLUMN "perp_max_leverage" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "copy_perp_max_leverage" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_trade_follows" ADD CONSTRAINT "copy_trade_follows_perp_max_leverage_range_check" CHECK ("perp_max_leverage" IS NULL OR "perp_max_leverage" BETWEEN 1 AND 100);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_copy_perp_max_leverage_range_check" CHECK ("copy_perp_max_leverage" BETWEEN 1 AND 100);
