-- @no-transaction
-- Forward repair for databases that journaled an older 0032 index definition.
-- Keep 0032 immutable: applied migration SQL is part of the database history.
-- PostgreSQL forbids CONCURRENTLY inside a transaction, so the forward runner
-- applies this migration outside one and journals it only after every index is
-- rebuilt successfully.
DROP INDEX CONCURRENTLY IF EXISTS "public"."copy_trade_follows_follower_created_at_id_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "copy_trade_follows_follower_created_at_id_idx" ON "public"."copy_trade_follows" USING btree ("follower_user_id", (date_trunc('milliseconds', "created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), "id");--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "public"."copy_trade_follows_auto_mirror_created_at_id_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "copy_trade_follows_auto_mirror_created_at_id_idx" ON "public"."copy_trade_follows" USING btree ("auto_mirror", (date_trunc('milliseconds', "created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), "id");--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "public"."signals_created_at_id_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "signals_created_at_id_idx" ON "public"."signals" USING btree ((date_trunc('milliseconds', "created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), "id");--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "public"."signals_timestamp_id_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "signals_timestamp_id_idx" ON "public"."signals" USING btree ((date_trunc('milliseconds', "timestamp" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), "id");--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "public"."social_trades_created_at_id_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "social_trades_created_at_id_idx" ON "public"."social_trades" USING btree ((date_trunc('milliseconds', "created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), "id");
