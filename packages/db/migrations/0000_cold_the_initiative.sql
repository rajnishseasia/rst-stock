CREATE TYPE "public"."signal_status" AS ENUM('PENDING', 'TRADED', 'IGNORED');--> statement-breakpoint
CREATE TYPE "public"."asset_type" AS ENUM('EQUITY', 'OPTION');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('long', 'short');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('PENDING', 'SUBMITTED', 'FILLED', 'PARTIAL', 'CANCELLED', 'REJECTED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('Market', 'Limit', 'StopMarket', 'StopLimit');--> statement-breakpoint
CREATE TYPE "public"."trade_action" AS ENUM('Buy', 'Sell', 'SellShort', 'BuyToCover', 'BuyToOpen', 'SellToClose', 'SellToOpen', 'BuyToClose');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text,
	"image" text,
	"username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"symbol" text NOT NULL,
	"content" text NOT NULL,
	"url" text,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"status" "signal_status" DEFAULT 'PENDING' NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_api_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"account_id" text,
	"account_type" text,
	"username" text,
	"base_url" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"signal_id" uuid,
	"symbol" text NOT NULL,
	"asset_type" "asset_type" NOT NULL,
	"order_type" "order_type" NOT NULL,
	"trade_action" "trade_action" NOT NULL,
	"direction" "direction" DEFAULT 'long' NOT NULL,
	"quantity" integer NOT NULL,
	"limit_price" numeric(12, 4),
	"stop_price" numeric(12, 4),
	"price_trigger" numeric(12, 4),
	"max_risk" numeric(12, 2),
	"stop_market_price" numeric(12, 4),
	"option_expiration" text,
	"option_strike" numeric(12, 4),
	"option_type" text,
	"status" "order_status" DEFAULT 'PENDING' NOT NULL,
	"broker_order_id" text,
	"broker_account_id" text,
	"executed_price" numeric(12, 4),
	"executed_quantity" integer,
	"notes" text,
	"skip_preset_tp" boolean DEFAULT false,
	"force_three_contracts" boolean DEFAULT false,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_api_credentials" ADD CONSTRAINT "user_api_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE set null ON UPDATE no action;