ALTER TABLE "social_trades" ADD COLUMN "order_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "social_trades" ADD CONSTRAINT "social_trades_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "social_trades_order_id_idx" ON "social_trades" USING btree ("order_id");