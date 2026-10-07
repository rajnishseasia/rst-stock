CREATE TABLE IF NOT EXISTS "copy_mirror_checkpoints" (
	"consumer" text PRIMARY KEY NOT NULL,
	"watermark" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "copy_mirror_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"follower_user_id" text NOT NULL,
	"credential_id" uuid,
	"source_item_id" text NOT NULL,
	"candidate" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"outcome" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_mirror_deliveries_follower_source_unique" UNIQUE("follower_user_id","source_item_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "copy_mirror_deliveries" ADD CONSTRAINT "copy_mirror_deliveries_follower_user_id_users_id_fk" FOREIGN KEY ("follower_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "copy_mirror_deliveries" ADD CONSTRAINT "copy_mirror_deliveries_credential_id_user_api_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."user_api_credentials"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_mirror_deliveries_due_idx" ON "copy_mirror_deliveries" USING btree ("status","next_attempt_at");