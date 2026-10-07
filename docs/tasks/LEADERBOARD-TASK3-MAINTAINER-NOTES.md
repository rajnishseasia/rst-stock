# Task 3 Maintainer Notes

## Migration

This branch keeps the applied migration history immutable and adds the
forward-only repair `0035_restore_copy_mirror_indexes`. Deploy the complete
committed chain through `0035_restore_copy_mirror_indexes`; do not select or
apply only a subset. The repair is needed for production databases that
journaled an older reviewed variant of `0032_new_moon_knight` with incomplete
or incorrectly qualified copy-mirror indexes.

For local development, use the normal dotenv-backed command:

```sh
bun run db:validate
bun run db:migrate
```

For Supabase production, inject the direct or session-mode Postgres URL on
port 5432 as `DATABASE_URL_DIRECT`, without loading a local dotenv file:

```sh
bun run db:validate
bun run db:migrate:production
bun run db:verify-worker-schema
```

The forward runner validates that the live Drizzle journal is a contiguous
prefix of the committed journal and that every recorded SQL hash matches a
reviewed migration. It accepts only the two known historical `0032` hashes;
the runner then applies `0035`, which drops and recreates the five required
copy-mirror indexes concurrently and journals the repair only after every
index succeeds. Unknown, missing, duplicated, or tampered journal rows fail
closed. Never rewrite an applied SQL file, delete a journal row, or use
`db:push` to work around this check.

`0032_new_moon_knight`, `0034_quiet_shadowcat`, and
`0035_restore_copy_mirror_indexes` are intentionally non-transactional because
they create or replace indexes concurrently. The runner holds a bounded,
session-scoped PostgreSQL advisory lock while validating and applying them;
an overlapping deploy fails with a retryable message instead of waiting
forever. The worker-schema verifier uses the same lock, so it cannot inspect
a schema during a concurrent index repair.

Deployment ordering is enforced by the Railway worker's pre-deploy sequence.
Railway runs `db:validate`, `db:migrate:production`, and
`db:verify-worker-schema` before the worker starts. The Vercel API build does
not apply or verify migrations and does not touch the database. If an API and
worker release share a schema change, deploy the worker first and confirm the
three Railway log markers before deploying the API. Do not start a new worker
against a database that fails the schema gate.

The worker startup gate checks migration `0029_free_whirlwind` and the live
canonical-ingestion schema from `0030_curious_vindicator` plus
`0031_useful_pixie`, as well as the copy-mirror indexes restored by `0035`. It
verifies the partial source-event unique index, the alias foreign key and
identity uniqueness, signal identity columns, cursor health/boundary
timestamps, identity/alias persistence columns, lookup constraints, and
copy-mirror indexes before Redis or any poller starts.

## Identity compatibility

New observations use `source_author:<source>:<immutable-id>` as the canonical
follow/profile key. Handles and display names are retained in
`source_author_aliases` and signal metadata. Alias observations, resolution,
leaderboard buckets, profile lookups, follows, and mirror matching are all
source-scoped. An old normalized-name follow key continues to match a new
signal only when the alias has one durable owner within that source. Ambiguous
aliases, including fallback display-name keys, are removed from compatibility
matching. Historical rows are not destructively guessed or rewritten by the
migration; API grouping and existing metadata provide a source-qualified
read-time fallback when it is unambiguous. Discord webhook, bot, and relay IDs
identify the transport, not the X caller, so they are never promoted to
canonical author IDs. A source author ID is used only when its provenance is
explicit and immutable for that source.

## Cursor and recovery operations

Discord uses `discord:channel:<channel-id>` and a snowflake cursor. The main
cursor is forward-only, while `backfill_cursor` and `backfill_complete` store a
separate raw backward boundary. Startup recovery walks backward in bounded
pages, processes the oldest rows first, and resumes the remaining older range
on later passes when the cap is reached. Forward polling also paginates,
processes oldest to newest, and persists the cursor after each event with a
database CAS on `cursor_sequence`. A page boundary advances only after every
valid row in that page has been processed. The default history setting is 10
pages and the hard recovery cap is 5,000 messages. Malformed events,
malformed timestamps, and implausibly future timestamps are quarantined and
logged while their safe source IDs advance the source cursor.

paste.trade uses `paste.trade:board:today` and stores the consumed board version
after a complete board pass. The version and computed-at watermark use a
database CAS, so a stale replica cannot move them backward. A failed board read
or signal write leaves the version unadvanced for retry. Rows with malformed,
future, or otherwise invalid event shapes are logged and skipped without
blocking later rows in the same board pass.

Signal inserts use a source-qualified immutable event ID with the partial
database unique index and intentional targetless `ON CONFLICT DO NOTHING`
semantics. Existing metadata-based dedup remains in place for historical rows.
Copy-mirror delivery and order idempotency constraints remain the final race
guards for retried or overlapping work.
