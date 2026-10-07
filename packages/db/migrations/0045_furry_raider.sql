ALTER TABLE "orders" ADD COLUMN "initial_take_profit_px" numeric(24, 8);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "initial_stop_loss_px" numeric(24, 8);