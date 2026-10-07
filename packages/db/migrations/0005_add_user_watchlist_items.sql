CREATE TABLE IF NOT EXISTS "user_watchlist_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "symbol" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_watchlist_items" ADD CONSTRAINT "user_watchlist_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_watchlist_items_user_id_idx" ON "user_watchlist_items" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_watchlist_items_user_sort_idx" ON "user_watchlist_items" ("user_id","sort_order");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_watchlist_items_user_symbol_idx" ON "user_watchlist_items" ("user_id","symbol");
