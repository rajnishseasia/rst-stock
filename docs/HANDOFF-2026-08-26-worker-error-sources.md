# Handoff: remaining worker error sources (2026-08-26)

Written for whoever (human or agent) picks up the worker error-burst alert next.
Two error sources are known, accepted, and deliberately NOT fixed. This document
exists so the next person does not rediscover them from scratch, and does not
assume a quiet alert channel means a quiet worker.

## Read this first: the alert now fires at most once a day

`ERROR_BURST_COOLDOWN_MS` in
`packages/logger/src/extensions/error-burst-alert.ts` was raised from 1 hour to
24 hours. The counting window is still one hour, so the alert still reports a
real hourly rate. It just says it at most once a day.

The reason is issue 1 below: it clears the >20/hour threshold on its own, so an
hourly cooldown produced 24 identical alerts a day and a channel nobody reads.

**The consequence to keep in mind: a NEW error source that appears an hour after
an alert stays silent until the window reopens.** Silence in the alert channel is
not evidence that the worker is healthy. Two paths deliberately bypass this
cooldown and still arrive immediately:

- `apps/worker/src/lib/fatal-alert.ts`, the awaited alert for a worker that dies
  during startup.
- Railway's own "Deployment Crashed" webhook.

When issue 1 is fixed, put the cooldown back to something shorter. It was raised
to work around an unfixed bug, not because a day is the right cadence.

## Issue 1: Hyperliquid 429s are logged as hard errors, with no backoff

**This is the current top error source and the reason the cooldown was raised.**

Measured rate: 4 `logger.error` calls in the first 36 seconds after the
2026-08-26 10:32 UTC deploy. That is far above the >20/hour alert threshold on
its own.

Two call sites, both logging a retryable rate limit as a terminal error:

- `apps/worker/src/services/hyperliquid-external-fill-sync.ts:205`
  `[hyperliquid-external-fill] credential failed`, error
  `429 Too Many Requests - null`. Poll interval 60s.
- `apps/worker/src/services/hyperliquid-order-sync.ts:404`
  `[hyperliquid-order-sync] failed processing address:0x...`, same error. Poll
  interval 30s.

A third site already gets this right and logs at `warn`:
`[hyperliquid-external-fill] trigger snapshot failed`. It is still a dropped
cycle, just not an alerting one.

Root cause: `packages/hyperliquid/src/client.ts` builds a bare `HttpTransport`
from `@nktkas/hyperliquid` (^0.33.1) with no retry or backoff configured, and
nothing in the worker's Hyperliquid path handles a 429. Confirmed by grep: there
is no reference to `429`, `Too Many Requests`, `retryAfter`, or `retry_after`
anywhere in the Hyperliquid client or its two pollers.

Suggested fix, in the order a reviewer would want it:

1. Retry the 429 at the transport or client boundary, not at each call site.
   `withRetry` from `@trade-bot/utils` already does exponential backoff with
   jitter, is already imported in `client.ts:11`, and accepts a `retryOn`
   predicate. That is the smallest correct change.
2. Whatever survives the retry should be logged at `warn`, not `error`. A
   dropped Hyperliquid cycle is self-healing: the watermark is deliberately not
   advanced (see the comment at `hyperliquid-external-fill-sync.ts:200`), so the
   next cycle retries the same window.
3. Reserve `logger.error` for failures that do not fix themselves, since that is
   the only level the burst alerter counts.

The same shape was fixed for Discord in PR #199
(`apps/worker/src/services/discord-poller.ts`, `fetchWithRateLimitRetry` plus
`resolveDiscordRetryAfterMs`). Copy the structure, including the rule that a
rate limit too long to wait out is surfaced rather than retried through.

## Issue 2: seven Alpaca credentials cannot be decrypted

Different failure, different severity, and it is NOT visible in the alert
channel at all.

```
[ExternalFillPoller] Failed processing credential <uuid>:
  Unsupported state or unable to authenticate data
```

Seven of these per poll cycle, at `apps/worker/src/services/external-fill-sync.ts:707`.

Two things make this easy to miss:

- It goes through `console.error`, not `logger.error`, so the burst alerter
  never sees it. It could run for months without tripping anything. (Compare the
  note in `order-sync.ts` about raw `console.error` hiding the loudest failure in
  the worker.)
- The poller catches per credential and continues, so the cycle looks healthy.

What the message actually means: `decrypt()` in
`packages/utils/src/utils/encryption.ts` is AES-256-GCM, and that string is the
Node authentication-tag failure thrown by `decipher.final()`. The stored
ciphertext was not produced by the current `ENCRYPTION_KEY`.

**The important detail: it is only some credentials.** Other credentials decrypt
and process normally in the same cycle (the same log window contains
`Sharing disabled for user ...` and `rescan window pinned ...` lines for other
users). So this is not a wrong key in the worker's environment. It is a subset
of rows encrypted under a previous key, or corrupted at rest.

Impact while it is unfixed: those seven users' external Alpaca fills are never
synced. Nothing else in the system reports that, and the affected users get no
signal.

Suggested investigation:

1. Identify the affected rows in `user_api_credentials` and check whether they
   share a `created_at` era. A key rotation with no re-encryption backfill is
   the obvious hypothesis; confirm it before acting on it.
2. Decide the remediation deliberately: re-encrypt from a retained old key if
   one exists, otherwise the credentials are unrecoverable and the affected
   users have to re-enter their keys. Re-entry must go through the
   verification path in `apps/api/src/lib/alpaca-credential-check.ts`.
3. Independently of the outcome, promote that `console.error` to
   `logger.error` so this class of failure is visible to alerting. Mask the
   credential id and never log the user's email.

Do not paste credential ciphertext, key material, or raw user identifiers into
a PR or a log while investigating this.

## Already fixed, for context

PR #199 (merged 2026-08-26 10:30 UTC, deployed as `7b7b6d4a` at 10:32 UTC)
resolved the two services named in the original alert:

- `order-sync`, 17 errors/hour: the monotonic execution UPDATE bound the broker
  fill time as an untyped null parameter, so Postgres rejected the whole
  statement with `could not determine data type of parameter $10`. Because that
  UPDATE is the only thing that advances an order, seven orders were frozen and
  could not record a fill at all. Verified fixed in production: all seven moved
  `SUBMITTED -> FILLED` and attached their exit plans within 40 seconds of the
  deploy.
- `discord`, 4 errors/hour: a 429 with a sub-second `retry_after` aborted the
  whole poll cycle. Now retried, with a bound on how long a wait is worth
  absorbing.

The Discord retry path has not yet been exercised in production. Discord had not
rate-limited the worker again as of 10:33 UTC, so it is covered by tests only.
