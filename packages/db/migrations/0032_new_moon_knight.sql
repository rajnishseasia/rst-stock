-- @no-transaction
-- Rebuild, rather than name-skip, every index. A canceled CREATE INDEX CONCURRENTLY
-- can leave an invalid relation, and a same-name wrong definition is just as unsafe.
DROP INDEX CONCURRENTLY IF EXISTS "copy_trade_follows_follower_created_at_id_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "copy_trade_follows_follower_created_at_id_idx" ON "copy_trade_follows" USING btree ("follower_user_id", (date_trunc('milliseconds', "created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), "id");--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "copy_trade_follows_auto_mirror_created_at_id_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "copy_trade_follows_auto_mirror_created_at_id_idx" ON "copy_trade_follows" USING btree ("auto_mirror", (date_trunc('milliseconds', "created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), "id");--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "signals_created_at_id_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "signals_created_at_id_idx" ON "signals" USING btree ((date_trunc('milliseconds', "created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), "id");--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "signals_timestamp_id_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "signals_timestamp_id_idx" ON "signals" USING btree ((date_trunc('milliseconds', "timestamp" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), "id");--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "social_trades_created_at_id_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "social_trades_created_at_id_idx" ON "social_trades" USING btree ((date_trunc('milliseconds', "created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), "id");
