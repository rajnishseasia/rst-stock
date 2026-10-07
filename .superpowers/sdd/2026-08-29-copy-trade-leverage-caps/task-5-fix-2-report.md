# Task 5 fix round 2: preserve durable perp placement tracking

## Result

- Split non-reduce-only fresh and resumed Hyperliquid opens into three phases.
  Phase A commits the deterministic, exact payload/account/network and
  conservative leverage snapshot as a `PENDING` order intent before policy
  locking. Phase B locks the follower `users` row with `FOR UPDATE`, rereads
  the owned follow and exact registered credential, rebuilds the client from
  that exact credential, and holds the transaction through final leverage
  resolution, application, and venue submission. Phase B performs no order
  status or protection writes. Phase C runs independent short transactions to
  finalize accepted/rejected results; accepted or ambiguous status failures
  leave the durable intent `PENDING` (with best-effort `placedAt`) for the
  reconciler, while definitive rejection becomes `REJECTED`.
- Fresh and resumed protection work is post-commit and isolated from placement
  tracking, so a protection exception cannot roll back or requeue a venue
  order. Reduce-only fresh and resumed closes remain outside the policy lock.
- Follow/unfollow, global/per-follow leverage, Alpaca credential replacement,
  Hyperliquid enable/agent replacement/registration, and credential deletion
  use the same user-first lock order. Credential deletion rechecks ownership
  under the lock and disarms only the owner's follows atomically.
- Resume leverage reconciliation caps any venue-reported value at the final
  effective clamp and repairs a stale stored value even when no live position
  is returned. Both worker client construction paths select the exact validated
  credential ID.
- Short opens remain enabled. The exact venue-formatted size multiplied by the
  aggressive sell limit price is capped, while the existing conservative
  pre-sizing high-bound cap remains. The submitted-payload cap is intentionally
  distinct from an unbounded favorable future fill price on a sell IOC.

## TDD and verification evidence

Focused worker sizing/mirror suites:

```text
bun test apps/worker/src/services/__tests__/copy-mirror.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-sizing.test.ts --bail 0
  279 pass, 0 fail, 634 expect() calls across 3 files
```

Focused API mutation/credential suites:

```text
bun test apps/api/src/__tests__/copy-trade-follows.test.ts apps/api/src/__tests__/delete-credential-disarm.test.ts apps/api/src/__tests__/user-settings-save-credentials.test.ts apps/api/src/__tests__/hyperliquid-enable-upsert.test.ts apps/api/src/__tests__/hyperliquid-agent-rotation.test.ts --bail 0
  105 pass, 0 fail, 272 expect() calls across 6 files
```

Full worker service suite (explicit test-file list):

```text
  1145 pass, 0 fail, 2703 expect() calls across 59 files
```

Static checks:

```text
bun run --cwd apps/worker typecheck       pass
bun run --cwd apps/api typecheck          pass
bunx oxlint <changed worker/API files>    pass
git diff --check                           pass (line-ending normalization warnings only)
```

The aggregate API explicit test-file run reached 219 passing tests across 17
files, then hit an unhandled Bun module-mock/import failure in
`copy-trade-mirror-status.test.ts` (`createBrokerClientOrderId` is absent from
the mocked `@trade-bot/alpaca` module). The relevant changed-router/API suites
above pass in isolation/combined execution.

No migration, restart, live database mutation, live order, push, or deployment
was performed.
