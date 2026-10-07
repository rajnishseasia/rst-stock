ALTER TABLE "orders" ADD COLUMN "close_absence_first_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "close_absence_observations" integer DEFAULT 0 NOT NULL;