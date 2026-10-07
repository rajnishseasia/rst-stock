ALTER TABLE "signal_ingestion_cursors" ADD COLUMN "cursor_sequence" text;--> statement-breakpoint
ALTER TABLE "signal_ingestion_cursors" ADD COLUMN "backfill_cursor" text;--> statement-breakpoint
ALTER TABLE "signal_ingestion_cursors" ADD COLUMN "backfill_complete" boolean DEFAULT false NOT NULL;