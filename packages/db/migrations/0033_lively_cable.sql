ALTER TABLE "copy_trade_follows" ADD COLUMN "perp_take_profit_pct" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "copy_trade_follows" ADD COLUMN "perp_stop_loss_pct" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "perp_protection" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "perp_protection_status" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "perp_protection_error" text;
