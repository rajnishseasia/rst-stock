-- PostgreSQL forbids CONCURRENTLY inside a transaction. Apply this migration
-- directly through psql/DATABASE_URL_DIRECT, not through a transactional runner.
CREATE INDEX IF NOT EXISTS "signals_normalized_author_timestamp_idx" ON "signals" USING btree (lower(regexp_replace(regexp_replace(btrim(coalesce("metadata"->>'authorName', '')), '\s*[•·|–-]\s*TweetShift\s*$', '', 'i'), '\s+', ' ', 'g')),"timestamp" DESC NULLS LAST);
