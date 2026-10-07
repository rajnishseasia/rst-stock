CREATE INDEX IF NOT EXISTS "signals_timestamp_idx" ON "signals" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_api_credentials_user_provider_idx" ON "user_api_credentials" USING btree ("user_id","provider","account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_user_id_created_at_idx" ON "orders" USING btree ("user_id","created_at");