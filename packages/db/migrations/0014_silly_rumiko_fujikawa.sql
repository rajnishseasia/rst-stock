DO $$ BEGIN
 CREATE TYPE "public"."smart_exit_leg_status" AS ENUM('pending', 'submitting', 'retryable', 'attached', 'manual_intervention');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."smart_exit_leg_type" AS ENUM('take_profit', 'trailing_stop');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "smart_exit_legs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_order_id" uuid NOT NULL,
	"leg_key" text NOT NULL,
	"leg_type" "smart_exit_leg_type" NOT NULL,
	"status" "smart_exit_leg_status" DEFAULT 'pending' NOT NULL,
	"client_order_id" text NOT NULL,
	"broker_order_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"quantity" integer NOT NULL,
	"limit_price" numeric(12, 4),
	"stop_price" numeric(12, 4),
	"trail_percent" numeric(8, 4),
	"error" text,
	"attached_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "smart_exit_legs" ADD CONSTRAINT "smart_exit_legs_entry_order_id_orders_id_fk" FOREIGN KEY ("entry_order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "smart_exit_legs_entry_order_leg_key_unique" ON "smart_exit_legs" USING btree ("entry_order_id","leg_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "smart_exit_legs_client_order_id_unique" ON "smart_exit_legs" USING btree ("client_order_id");