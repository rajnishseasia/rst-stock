CREATE TABLE IF NOT EXISTS "source_author_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"source" text NOT NULL,
	"alias" text NOT NULL,
	"alias_type" text DEFAULT 'observed' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_author_aliases_identity_alias_unique" UNIQUE("identity_id","alias")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_author_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_author_id" text NOT NULL,
	"canonical_key" text NOT NULL,
	"current_handle" text,
	"current_display_name" text,
	"avatar_url" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_author_identities_canonical_key_unique" UNIQUE("canonical_key"),
	CONSTRAINT "source_author_identities_source_author_unique" UNIQUE("source","source_author_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signal_ingestion_cursors" (
	"source" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"watermark" timestamp with time zone,
	"status" text DEFAULT 'healthy' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "source_event_id" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "source_author_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "source_author_aliases" ADD CONSTRAINT "source_author_aliases_identity_id_source_author_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."source_author_identities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_author_aliases_source_alias_lookup_idx" ON "source_author_aliases" USING btree ("source","alias");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_author_aliases_identity_lookup_idx" ON "source_author_aliases" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_author_identities_source_lookup_idx" ON "source_author_identities" USING btree ("source","source_author_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signals_source_event_unique_idx" ON "signals" USING btree ("source","source_event_id") WHERE "signals"."source_event_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signals_source_author_idx" ON "signals" USING btree ("source","source_author_id");