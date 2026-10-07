CREATE TABLE IF NOT EXISTS "copy_trade_follows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "follower_user_id" text NOT NULL,
  "target_type" text NOT NULL,
  "target_key" text NOT NULL,
  "target_label" text,
  "sizing_mode" text DEFAULT 'pct' NOT NULL,
  "sizing_value" numeric(12, 2) DEFAULT '5' NOT NULL,
  "auto_mirror" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "copy_trade_follows_follower_target_unique" UNIQUE("follower_user_id","target_type","target_key")
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1
  FROM pg_constraint
  WHERE conrelid = 'public.copy_trade_follows'::regclass
    AND contype = 'f'
    AND confrelid = 'public.users'::regclass
 ) THEN
  ALTER TABLE "copy_trade_follows" ADD CONSTRAINT "copy_trade_follows_follower_user_id_users_id_fk" FOREIGN KEY ("follower_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_trade_follows_follower_user_id_idx" ON "copy_trade_follows" ("follower_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_trade_follows_target_idx" ON "copy_trade_follows" ("target_type","target_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "copy_trade_follows_follower_target_unique" ON "copy_trade_follows" ("follower_user_id","target_type","target_key");
