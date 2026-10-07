CREATE TABLE IF NOT EXISTS "hl_wallet_copy_cursors" (
	"follower_user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"watermark_ms" bigint DEFAULT 0 NOT NULL,
	"watermark_tid" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hl_wallet_copy_cursors_follower_user_id_wallet_address_pk" PRIMARY KEY("follower_user_id","wallet_address")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hl_wallet_copy_cursors" ADD CONSTRAINT "hl_wallet_copy_cursors_follower_user_id_users_id_fk" FOREIGN KEY ("follower_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hl_wallet_copy_cursors_follower_idx" ON "hl_wallet_copy_cursors" USING btree ("follower_user_id");