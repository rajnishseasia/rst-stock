CREATE TABLE IF NOT EXISTS "copy_mirror_failsafe_checks" (
	"exposure_key" text PRIMARY KEY NOT NULL,
	"follower_user_id" text NOT NULL,
	"source_wallet" text NOT NULL,
	"follower_wallet" text NOT NULL,
	"venue_network" text NOT NULL,
	"coin" text NOT NULL,
	"side" text NOT NULL,
	"exposure_size_decimal" text NOT NULL,
	"opening_client_order_ids" jsonb NOT NULL,
	"flat_observations" integer DEFAULT 0 NOT NULL,
	"first_flat_observed_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone NOT NULL,
	"close_source_item_id" text,
	"status" text DEFAULT 'watching' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "copy_mirror_failsafe_checks" ADD CONSTRAINT "copy_mirror_failsafe_checks_follower_user_id_users_id_fk" FOREIGN KEY ("follower_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_mirror_failsafe_checks_due_idx" ON "copy_mirror_failsafe_checks" USING btree ("status","last_checked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_mirror_failsafe_checks_follower_idx" ON "copy_mirror_failsafe_checks" USING btree ("follower_user_id");