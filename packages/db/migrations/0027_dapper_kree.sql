ALTER TABLE "orders" ADD COLUMN "realized_pnl" numeric;--> statement-breakpoint
-- Seed the new column from the realized PnL already recorded under the wrong
-- name, so the reconciler does not resume from null.
--
-- Every non-null `funding_paid` on this table is a Hyperliquid `closedPnl` sum:
-- nothing has ever written real funding, which is why the column is being
-- retired. Leaving these behind would not just lose history. The reconciler
-- EXTENDS the cumulative figure once a fill cursor is in play, so an active
-- partial order would resume from null and record only the fills after this
-- deployment, permanently dropping everything before it.
--
-- Scoped to hyperliquid rows for accuracy of intent; the column is empty
-- elsewhere. Guarded on realized_pnl being null so it can only ever fill a gap.
UPDATE "orders"
SET "realized_pnl" = "funding_paid"
WHERE "venue" = 'hyperliquid'
  AND "funding_paid" IS NOT NULL
  AND "realized_pnl" IS NULL;--> statement-breakpoint
-- DELIBERATELY does NOT clear `funding_paid` here.
--
-- This migration runs in the API build (apps/api/vercel.json) while the worker
-- deploys separately on Railway, so there is a window where the column exists
-- and the OLD worker is still reconciling. That worker writes the cumulative
-- PnL to `funding_paid` and advances the shared fill cursor, so anything it
-- records in the window would be invisible to the new code and, because the
-- cursor moved past those fills, never recoverable.
--
-- Emptying `funding_paid`, here or anywhere, would make that worse rather than
-- better: it is the OLD worker's accumulation base, so a null sends its next
-- fill back as a bare suffix instead of a running total. The column therefore
-- stays populated, and the new worker keeps it in step with `realized_pnl`,
-- writing the same value to both and sweeping any row where they disagree.
-- Correct whichever worker touches a row next. See `reconcileOne` and
-- `absorbLegacyRealizedPnl` in hyperliquid-order-sync.ts, and
-- `orders_hl_legacy_pnl_idx` in 0028, which keeps that sweep free.
--
-- The follow-up that retires all of this, once no old worker can be running,
-- drops the dual-write and nulls this column for good. Steps, ordering and the
-- check to run first are in docs/deployment/perp-pnl-column-split.md.
SELECT 1;
