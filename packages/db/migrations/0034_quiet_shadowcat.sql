-- @no-transaction
-- PostgreSQL forbids CONCURRENTLY inside a transaction. The forward migration
-- runner (packages/db/scripts/migrate-forward.ts) reads this directive and
-- applies the file outside one, so `bun run db:migrate` handles it.
--
-- Split out of 0033 for exactly that reason: 0033's ALTER TABLE statements are
-- fine transactionally, this is not. Built CONCURRENTLY so creating it does not
-- hold a write lock on `orders` for the duration of the scan.
--
-- Dropped before it is created, matching 0032: a canceled CREATE INDEX
-- CONCURRENTLY leaves an invalid relation behind, and a retry that skipped on
-- name alone would accept it.
DROP INDEX CONCURRENTLY IF EXISTS "orders_perp_protection_unprotected_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "orders_perp_protection_unprotected_idx" ON "orders" USING btree ("created_at") WHERE "orders"."perp_protection_status" = 'unprotected';
