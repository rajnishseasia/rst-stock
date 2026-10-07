CREATE TABLE IF NOT EXISTS "external_fill_cursors" (
	"credential_id" uuid PRIMARY KEY NOT NULL,
	"watermark" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "external_origin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_fill_cursors" ADD CONSTRAINT "external_fill_cursors_credential_id_user_api_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."user_api_credentials"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
