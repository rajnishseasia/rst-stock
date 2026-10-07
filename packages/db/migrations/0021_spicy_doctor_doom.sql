DROP INDEX IF EXISTS "user_watchlist_items_user_symbol_idx";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "watchlist_initialized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_watchlist_items" ADD COLUMN "venue" text DEFAULT 'stocks' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_watchlist_items_user_venue_symbol_idx" ON "user_watchlist_items" USING btree ("user_id","venue","symbol");