ALTER TYPE "asset_type" ADD VALUE IF NOT EXISTS 'PERP';--> statement-breakpoint
ALTER TYPE "order_type" ADD VALUE IF NOT EXISTS 'TakeProfitMarket';--> statement-breakpoint
ALTER TYPE "order_type" ADD VALUE IF NOT EXISTS 'TakeProfitLimit';--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "limit_price" SET DATA TYPE numeric(24, 8);--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "price_trigger" SET DATA TYPE numeric(24, 8);--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "executed_price" SET DATA TYPE numeric(24, 8);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "quantity_decimal" numeric(24, 8);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "executed_size_decimal" numeric(24, 8);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "leverage" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "margin_mode" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "reduce_only" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "funding_paid" numeric;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "venue" text DEFAULT 'alpaca';
