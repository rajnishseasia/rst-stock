ALTER TABLE "users" ADD COLUMN "share_trades" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "social_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"qty" integer NOT NULL,
	"order_type" text,
	"asset_type" text,
	"limit_price" numeric(12, 4),
	"broker_order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "social_trades" ADD CONSTRAINT "social_trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "social_trades_user_id_idx" ON "social_trades" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "social_trades_created_at_idx" ON "social_trades" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "social_trades_symbol_idx" ON "social_trades" USING btree ("symbol");
