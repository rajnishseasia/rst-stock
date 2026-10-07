# Verification: RST-004

- Ticket ID: RST-004
- Base SHA: 1d779ee0fd9ffc967ec1be837d77984c5d97acdc
- Reviewed-tree SHA: 153ea88762ba548913dc53d9ba48abb72c1c9204
- Model: Controller launch configuration for verifier agent 01a09691-2997-74a1-aedc-c2c5e0f7d7c6 was model gpt-5.6-luna with reasoning_effort max (controller-supplied). I cannot independently introspect runtime identity; this records launch configuration, not verified runtime identity.
- Round: 1 fresh cold STRICT review; Round 2 audit correction adds model provenance and clean-tree rerun evidence. No coder reasoning or agents used.
- Result: ACCEPT

## Findings

No code-level finding remains. No source correction is requested.

The original raw root test run is artifact-qualified: six ignored generated tests under packages/db/dist were present before the candidate commit. They were preserved, not deleted. For follow-up verification, the directory was temporarily moved outside the repository to obtain a clean-tree run and then restored intact; exact evidence is below.

## Identity and Scope

HEAD and the reviewed commit both resolve to 153ea88762ba548913dc53d9ba48abb72c1c9204, detached, with sole parent 1d779ee0fd9ffc967ec1be837d77984c5d97acdc. The tracked worktree was clean before review and remained clean after the gates.

The complete base-to-candidate diff has exactly these six authorized paths:

- M apps/api/src/__tests__/perp-trigger-router.test.ts
- A apps/api/src/__tests__/positions-perp-fills.test.ts
- M apps/worker/src/services/__tests__/hyperliquid-external-fill-sync.test.ts
- M apps/worker/src/services/__tests__/hyperliquid-order-sync.test.ts
- M apps/worker/src/services/hyperliquid-external-fill-sync.ts
- M apps/worker/src/services/hyperliquid-order-sync.ts

There is no schema or migration change, no change to the pure watermark helper, no change to RST-001/002 frozen mirror source/tests, no route or worker-registration change, and no production/live-system operation. The two worker source modules above are the explicitly authorized RST-003/004 production implementation paths. After candidate commit, only the two assigned review reports are written by this verifier; the ignored dist artifacts predate the commit.

## RST-004 Evidence

The new regression at apps/worker/src/services/__tests__/hyperliquid-order-sync.test.ts:341-403 starts with a persisted PARTIAL StopMarket parent at cumulative 0.03, adds a fresh venue fill delta of 0.04, and leaves 0.055 resting. It verifies the CAS update reaches cumulative 0.07, the synthetic child and social row are persisted, and exactly one notification carries side Sell, direction short, status PARTIAL, closeReason stop_loss, venue executedAt, and both quantity and quantityDecimal equal to the incremental 0.04 rather than cumulative 0.07. It then reconciles the unchanged venue snapshot against the persisted 0.07/cursor and confirms the notifier remains at one call and no second social event appears.

In hyperliquid-order-sync.ts:1510-1525 notification first requires a non-null result from the guarded persistence transaction. The new partial branch additionally requires update.status PARTIAL, hasExecutedDelta, non-null fillDelta, persisted.reduceOnly, and the existing closeReasonForOrderType result stop_loss. For a partial stop it selects fillDelta; at lines 1533-1565 it sends the actual status and update.executedAtMs. The row update, synthetic exact-delta child, and linked social trade remain inside the existing transaction at lines 1315-1507; notifier execution remains after commit.

The ordinary partial-open cases still assert no alerts at hyperliquid-order-sync.test.ts:482-547. Full reduce-only take-profit notification remains asserted at lines 282-321; full stop reason remains asserted at lines 324-339. A lost zero-row or multi-row CAS produces no notification at lines 591-627, and the only-winner concurrent terminal test remains at lines 405-420. The new alert cannot extend to a take-profit or manual close because the shared classification yields take_profit or null, while the new branch admits only stop_loss (discord-notify.ts:235-245; hyperliquid-order-sync.ts:1512-1522). The existing formatter marks PARTIAL with an explicit Partial prefix (discord-notify.ts:183-190, 413-489); the event reports the delta and does not claim the position is flat.

The separate positions contract at apps/api/src/__tests__/positions-perp-fills.test.ts:42-84 calls the real positionsRouter protected procedure. The fill has numeric OID 501; the fake DB returns string brokerOrderId 501 with StopMarket, and the result is enriched while unmatched OID 502 stays null. It asserts one batched lookup and the keyless fill call with the user's wallet and default limit. The test uses only local fake DB/fill I/O: createHyperliquidInfoClient caches by resolved network and traffic class at apps/api/src/lib/hyperliquid.ts:109-119, so the test replaces listFills on the same cached standard client the route obtains and restores it in finally at positions-perp-fills.test.ts:51-54, 81-83. In perp-trigger-router.test.ts:1-13 the four-line test-only partial mock spreads the real module exports, including createHyperliquidInfoClient; the diff adds no trigger assertions and removes or weakens none. Both focused and canonical suites passed without a network-dependent assertion.

## Strict Checklist Results

| Category | Result | Evidence |
|---|---|---|
| Money loss: wrong account | PASS | CAS is scoped by order ID, user ID, and Hyperliquid venue at hyperliquid-order-sync.ts:1378-1408; the notify payload uses the successfully persisted user's ID at lines 1533-1554. |
| Money loss: size | PASS | Decimal delta is derived before the CAS at hyperliquid-order-sync.ts:1272-1285, persisted as exact child quantity/executed size at lines 1428-1486, and sent as fillDelta for the partial alert at 1516-1525, 1533-1538. Regression asserts 0.04, not cumulative 0.07, at hyperliquid-order-sync.test.ts:362-387. |
| Money loss: side | PASS | Payload retains persisted tradeAction and direction at hyperliquid-order-sync.ts:1533-1559; regression expects Sell/short at hyperliquid-order-sync.test.ts:376-387. |
| Money loss: leverage | N/A | This change adds a notification path only; it neither submits an order nor changes leverage. Existing synthetic event copies persisted leverage inside the unchanged transaction at hyperliquid-order-sync.ts:1471-1476. |
| Money loss: consent | PASS | No follower consent, destination, or execution gate changed. The preexisting copy candidate and delivery path remains frozen; the partial social event is still created only in the existing transaction at hyperliquid-order-sync.ts:1428-1504 and is subject to the unchanged follower selection/delivery path. |
| Money loss: attribution | PASS | The updated row is selected with order/user/venue predicates at hyperliquid-order-sync.ts:1378-1408; child and social rows copy the persisted user/source attribution at lines 1444-1503; notification uses persisted userId/copySourceLabel at 1544-1554. |
| Parity: stocks and perps | PASS | The alert expansion is intentionally limited to Hyperliquid perp partial stop fills, as authorized by the brief; no stock/Alpaca path changed. |
| Parity: entry behavior | PASS | Opening/non-reduce-only StopMarket is not classified as stop_loss (discord-notify.ts:232-244; discord-notify-close-reason.test.ts:71-80); ordinary partial-open tests still expect zero notifications at hyperliquid-order-sync.test.ts:482-547. |
| Parity: exit behavior | PASS | Only a newly persisted reduce-only stop-loss partial delta uses the new alert branch (hyperliquid-order-sync.ts:1512-1525); full stop behavior remains covered at hyperliquid-order-sync.test.ts:324-339. |
| Boundary: empty | PASS | Missing/non-meaningful update returns before persistence or notify at hyperliquid-order-sync.ts:1262; a null CAS result returns before the new branch at lines 1510-1522. |
| Boundary: malformed | PASS | Null fillDelta is explicitly rejected before notification at hyperliquid-order-sync.ts:1516-1525; exact decimal derivation and existing order-sync tests cover fractional fill values at lines 1272-1285 and hyperliquid-order-sync.test.ts:341-387. |
| Boundary: missing | PASS | The no-row/lost-CAS path returns without notification at hyperliquid-order-sync.ts:1410-1424, 1510-1522; direct negative CAS assertions are at hyperliquid-order-sync.test.ts:591-627. |
| Boundary: stale | PASS | Venue update time is persisted from update.executedAtMs at hyperliquid-order-sync.ts:1353-1356 and passed unchanged to notifier at lines 1545-1548; the new regression asserts that exact venue timestamp at hyperliquid-order-sync.test.ts:348-386. Existing Discord stale-fill guard remains unchanged at discord-notify.ts:641-665. |
| Boundary: partial | PASS | The regression asserts persisted cumulative state, exact new delta, PARTIAL status, venue time, one social event, and one notification, then repeats the unchanged poll at hyperliquid-order-sync.test.ts:341-403. |
| Duplication: replay | PASS | Repeated unchanged venue state retains one notification and no new social row at hyperliquid-order-sync.test.ts:389-403; exact child-event identity still derives from cumulative size at lines 1432-1461. |
| Duplication: retries | PASS | Only a newly returned persisted row reaches notify; zero/multi-row CAS results return null before both full and partial notification paths (hyperliquid-order-sync.ts:1410-1424, 1510-1525; tests 591-627). Existing notifier throttle/state is unchanged. |
| Duplication: reconciliation | PASS | The parent cumulative-size and fill-cursor compare-and-set remains at hyperliquid-order-sync.ts:1378-1408, and partial replays are covered at hyperliquid-order-sync.test.ts:167-264, 389-403. |
| Duplication: competing workers | PASS | Concurrent transitions are guarded by the status, executed-size, and fill-cursor CAS at hyperliquid-order-sync.ts:1311-1315, 1378-1408; atomic delta publication is within that transaction at lines 1428-1507. Existing concurrent poller assertion remains at hyperliquid-order-sync.test.ts:405-420. |

## Commands and Results

Focused command, exactly as specified:

    bun test --timeout 30000 \
      apps/api/src/__tests__/hyperliquid-external-fill.test.ts \
      apps/api/src/__tests__/positions-perp-fills.test.ts \
      apps/worker/src/services/__tests__/hyperliquid-external-fill-sync.test.ts \
      apps/worker/src/services/__tests__/hyperliquid-order-sync.test.ts \
      apps/worker/src/services/__tests__/discord-notify-close-reason.test.ts \
      apps/worker/src/services/__tests__/copy-mirror-candidate-sources.test.ts \
      apps/worker/src/services/__tests__/copy-mirror-delivery-order.test.ts \
      apps/worker/src/services/__tests__/copy-mirror-durability.test.ts \
      apps/api/src/__tests__/perp-trigger-persistence.test.ts \
      apps/api/src/__tests__/perp-trigger-router.test.ts \
      apps/web-v2/src/components/perps/perp-closed-positions.test.ts \
      apps/web-v2/src/components/perps/perp-closed-panel.test.tsx

Exit 0. Exact summary: 273 pass, 0 fail, 658 expect() calls; Ran 273 tests across 12 files. [677.00ms].

Original raw artifact-contaminated run (non-canonical; post-typecheck generated tests were already present before this verifier's own typecheck):

    bun test --timeout 30000

Exit 0. Exact raw summary: 5235 pass, 46 skip, 0 fail, 15538 expect() calls; Ran 5281 tests across 330 files. [12.03s]. This is retained as non-canonical artifact-qualified evidence.

The six ignored generated test paths present in that raw run were:

- packages/db/dist/migration-compatibility.test.js
- packages/db/dist/connections/pool.test.js
- packages/db/dist/__tests__/canonical-ingestion.test.js
- packages/db/dist/__tests__/copy-trade-leverage-schema.test.js
- packages/db/dist/__tests__/timestamp-key-indexes.test.js
- packages/db/dist/__tests__/leaderboard-task3.integration.test.js

Canonical clean-tree rerun: before testing, the complete packages/db/dist directory was moved (not deleted) to the sibling path ../rst-p0-close-coder-dist-hold-153ea887, outside the repository. It was restored after the run. The aggregate SHA-256 fingerprint of its files before and after was identical: 557a04b6d26a6c60745b5ae33eb1f44c0cb049a0dce7e1685d82475519d7c4a1.

    bun test --timeout 30000

Exit 0. Exact clean summary: 5184 pass, 40 skip, 0 fail, 15247 expect() calls; Ran 5224 tests across 324 files. [13.00s]. This clean run is canonical for the verdict.

Accepted clean integrated base supplied by the brief: 5181 pass, 40 skip, 0 fail, 15223 expects across 323 files. Clean candidate delta: +3 pass, 0 skip, 0 fail, +24 expects, +1 file. Base and clean candidate failing-name sets are both empty.

    bun run check-types

Exit 0; 11 successful / 11 total, 11 cached.

    bun run lint

Exit 0; 23 warnings, matching the accepted-base total. Warning locations: packages/alpaca/src/client.test.ts:394; apps/web-v2/src/components/trade/trade-form.tsx:1114, 1918, 2258, 2263, 2363; apps/web-v2/src/components/feed/signal-feed.tsx:66; scripts/check-social-trades.ts:4; scripts/check-leaderboard-data.ts:6 (eight unused imports), 14, 15; apps/api/src/__tests__/alpaca-real-integration.test.ts:57; apps/web-v2/src/components/signa/signa-info-dialog.tsx:27; apps/api/scripts/chat-tools-smoke.ts:42; apps/web-v2/src/app/app/venue-aware-panels.tsx:55; apps/api/src/routers/leaderboard.ts:552. None is in a changed path.

    git diff --check
    git diff --check 1d779ee0fd9ffc967ec1be837d77984c5d97acdc 153ea88762ba548913dc53d9ba48abb72c1c9204

Both exited 0 with no output. Before report creation, git status was clean; no tracked or untracked gate output appeared.

## Remaining Operational or Release Proof

Historical incident attribution, copy-enabled live follower proof, and production latency remain release proof, not local patch acceptance claims. No production/live service, credentials, wallet, signer, or order submission was used.
