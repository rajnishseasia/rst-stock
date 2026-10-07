CREATE TABLE IF NOT EXISTS "user_llm_api_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "provider" text NOT NULL,
  "label" text,
  "encrypted_api_key" text NOT NULL,
  "api_key_last4" text NOT NULL,
  "base_url" text NOT NULL,
  "default_model" text NOT NULL,
  "last_used_at" timestamp with time zone,
  "last_validated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_llm_api_credentials" ADD CONSTRAINT "user_llm_api_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_llm_api_credentials_user_provider_idx" ON "user_llm_api_credentials" ("user_id","provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_llm_api_credentials_user_id_idx" ON "user_llm_api_credentials" ("user_id");


UPDATE "orders" SET "skip_preset_tp" = false WHERE "skip_preset_tp" IS NULL;--> statement-breakpoint
UPDATE "orders" SET "force_three_contracts" = false WHERE "force_three_contracts" IS NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "skip_preset_tp" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "force_three_contracts" SET NOT NULL;
