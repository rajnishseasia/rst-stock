ALTER TABLE "copy_trade_follows" ADD COLUMN "credential_id" uuid;--> statement-breakpoint
UPDATE "copy_trade_follows" SET "auto_mirror" = false WHERE "auto_mirror" = true;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "copy_trade_follows" ADD CONSTRAINT "copy_trade_follows_credential_id_user_api_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."user_api_credentials"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
