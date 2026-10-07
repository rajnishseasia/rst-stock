# Task 5 fix round 4: serialize pending perp placement claims

## Result

- Fresh and resumed non-reduce-only Hyperliquid perp attempts now carry a unique
  durable claim token in the existing `orders.sync_reason` field and a lease
  timestamp in `last_sync_attempt_at`. The Phase-A insert/reclaim is a compare-
  and-set, active claims are not stolen, and the policy transaction locks the
  follower user before the exact token-owned `PENDING` order. The transaction-
  scoped submitter verifies that token immediately before the venue request;
  Phase-C status and metadata writes use the same token, full identity, pending
  status, and null broker-id predicates. Accepted/recovered attempts clear the
  lease; ambiguous attempts keep it for reconciliation.
- Expired-lease retries probe Hyperliquid by cloid before submitting again and
  recover a matching venue order. Failed or incomplete venue reads, a lost claim,
  and a missing broker id fail closed without a second venue request or false
  protection bookkeeping. Future lease timestamps are treated as active to avoid
  clock-skew cancellation.
- Hyperliquid order-sync absence cancellation now compares the scanned
  `last_sync_attempt_at` and `sync_reason` values in the current-row CAS. A stale
  absence snapshot therefore cannot cancel a row after Phase A stamps a lease;
  positive fill/resting evidence remains authoritative.
- Phase-C reconciliation annotations are PENDING- and owner-guarded and reread
  authoritative status after a lost CAS, so a terminal reconciler result cannot
  be overwritten with stale notes or leverage. Legacy cloid-conflict placement
  now requires the strict full-payload matcher and guards recovery, rejection,
  ambiguous `placed_at`, and reconciliation-note writes with exact identity;
  reduce-only close retries retain their live-size behavior.
- Resume identity matching allows stored positive leverage to differ from the
  newly conservative resume input, while still requiring immutable identity and
  retaining strict leverage matching for fresh/legacy opens. This preserves
  policy-cap clamping without authorizing payload changes. Existing $10.55/
  2x/daily-one sizing and reduce-only close behavior remain intact.

## TDD and verification evidence

Focused copy-mirror and Hyperliquid sync suites:

```text
bun test apps/worker/src/services/__tests__/copy-mirror.test.ts apps/worker/src/services/__tests__/hyperliquid-order-sync.test.ts --bail 0 --dots
  324 pass, 0 fail, 753 expect() calls
```

Full worker source suite:

```text
bun test apps/worker/src --bail 0 --dots
  1172 pass, 0 fail, 2784 expect() calls
```

Static checks:

```text
bunx tsc --noEmit -p apps/worker/tsconfig.json       pass
bunx oxlint <six changed worker files>               pass
git diff --check                                      pass (line-ending warnings only)
```

No schema migration, service startup, database migration, live order, push, or
deployment was performed. The unrelated dirty protected web files
`apps/web-v2/next-config.test.ts`, `apps/web-v2/next-env.d.ts`, and
`apps/web-v2/next.config.ts` were left untouched and unstaged.

The requested commit message is `fix: serialize pending perp placement claims`.
