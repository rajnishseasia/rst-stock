ALTER TYPE "order_status" ADD VALUE 'SYNCING';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "broker_client_order_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "broker_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "sync_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "sync_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "last_sync_attempt_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_broker_credential_id_user_api_credentials_id_fk" FOREIGN KEY ("broker_credential_id") REFERENCES "public"."user_api_credentials"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_user_client_order_id_idx" ON "orders" USING btree ("user_id","client_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_user_broker_order_id_idx" ON "orders" USING btree ("user_id","broker_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_user_broker_client_order_id_idx" ON "orders" USING btree ("user_id","broker_client_order_id");