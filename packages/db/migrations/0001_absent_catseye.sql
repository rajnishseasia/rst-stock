ALTER TABLE "signals" ALTER COLUMN "metadata" SET DATA TYPE jsonb USING "metadata"::jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "status_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "client_order_id" text;--> statement-breakpoint
CREATE INDEX "signals_symbol_status_idx" ON "signals" USING btree ("symbol","status");--> statement-breakpoint
CREATE INDEX "orders_user_id_status_idx" ON "orders" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "orders_broker_order_id_idx" ON "orders" USING btree ("broker_order_id");
