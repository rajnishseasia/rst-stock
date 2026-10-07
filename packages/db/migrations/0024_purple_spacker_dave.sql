ALTER TABLE "orders" ADD COLUMN "venue_network" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "last_counted_fill_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "placed_at" timestamp with time zone;