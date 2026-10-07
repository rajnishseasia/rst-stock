ALTER TABLE "signals" ALTER COLUMN "timestamp" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signals" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signals" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "executed_quantity" SET DATA TYPE double precision;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_signal_id_idx" ON "orders" USING btree ("signal_id");