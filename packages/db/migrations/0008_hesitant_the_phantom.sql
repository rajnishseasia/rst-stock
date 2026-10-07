DO $$ BEGIN
 CREATE TYPE "public"."exit_plan_status" AS ENUM('pending', 'attached', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "exit_plan" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "exit_plan_status" "exit_plan_status";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "exit_plan_error" text;