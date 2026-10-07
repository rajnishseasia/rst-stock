# Task 5 fix round 3: preserve reconciled perp order state

## Result

- Phase-C Hyperliquid perp finalization is now monotonic and compare-and-set:
  accepted and rejected writes require the row to remain `PENDING`, use the
  shared status precedence expression, preserve a previously recorded broker
  order id, and verify exactly one affected row. A lost or failed CAS performs
  an authoritative reread and returns the settled venue-facing outcome when
  reconciliation already advanced the row. Accepted/ambiguous placed-at and
  lease fallback stamps are independently `PENDING`-guarded and reread after
  a lost fallback CAS, so they cannot overwrite a terminal reconciler state.
- Fresh and resumed non-reduce-only opens persist the deterministic payload,
  account, credential, network, leverage, and protection-rule intent before the
  policy lock. The policy transaction locks the follower user first, then the
  exact `PENDING` order, and holds both through final leverage application and
  Phase-B venue submission. The reconciler therefore cannot cancel or race a
  currently active placement; a short placement lease also suppresses
  absence-based cancellation while an ambiguous attempt is settling.
- Cloid-conflict adoption now fails closed unless every durable payload and
  identity field matches, including the schema-required perp `quantity === 0`
  placeholder. A mismatched payload returns `duplicate / identity-conflict`
  without a venue request.
- Protection bookkeeping is recorded only after Phase B returns an
  `accepted`, `ambiguous`, or `reconcile` submission (or when the policy
  transaction fails after one of those results). Pre-submit lock/read/apply
  failures, definitive rejections, and helper throws before a submission value
  exists do not create false `unprotected` backlog rows. Fresh and resumed
  tests cover each pre-return path.
- Existing copy-perp behavior remains intact, including the $10.55 sizing and
  2x leverage-cap copy used by the focused fixtures.

## TDD and verification evidence

Focused copy-mirror and Hyperliquid sync suites:

```text
bun test apps/worker/src/services/__tests__/copy-mirror.test.ts apps/worker/src/services/__tests__/hyperliquid-order-sync.test.ts --bail 0 --dots
  318 pass, 0 fail, 733 expect() calls across 3 files
```

Full worker service suite:

```text
bun test apps/worker/src --bail 0 --dots
  1166 pass, 0 fail, 2764 expect() calls across 59 files
```

Static checks:

```text
bun --filter @trade-bot/worker typecheck       pass
bunx oxlint <six changed worker files>        pass
git diff --check                               pass (line-ending normalization warnings only)
```

No services were started, no database was migrated or mutated, and no live
orders, push, or deployment were performed. The unrelated dirty
`apps/web-v2/next-config.test.ts`, `apps/web-v2/next-env.d.ts`, and
`apps/web-v2/next.config.ts` files were left untouched and unstaged.
