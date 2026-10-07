# Verification: RST-003

- Ticket ID: RST-003
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

## RST-003 Evidence

The new regression at apps/worker/src/services/__tests__/hyperliquid-external-fill-sync.test.ts:538-580 constructs 51 close fills with one identical millisecond timestamp and distinct OID, hash, and TID. It runs pollOnce three times. The first run has 50 durable rows/social rows/notifications; the second adds only broker OID 1050, reaches 51, checks 51 unique client IDs and one-to-one order/social/notification links; the third leaves all three counts unchanged. The test would fail against the base behavior: the strict time > watermark filter remains at hyperliquid-external-fill-sync.ts:467-469, while the base persisted the processed maximum timestamp after the capped prefix, excluding the deferred equal-time fill on the next poll.

The implementation at hyperliquid-external-fill-sync.ts:487-537 keeps oldest-first processing, records whether the cap actually deferred a fill, and rewinds only to max(observed watermark, processed maximum minus one millisecond) when the first deferred fill ties the processed maximum. Otherwise it persists the normal monotonic nextWatermarkMs result. No timestamp cursor is advanced to a later, unprocessed fill. The separate 500-fill scan limit at lines 113-121 is unchanged; this review makes no paging, scan-depth, or schema claim.

Stable identity is unchanged: externalHlClientOrderId hashes immutable venue hash/OID/TID at apps/api/src/lib/hyperliquid-external-fill.ts:92-110, and the actual orders clientOrderId unique index is packages/db/src/schema/orders.ts:393-397. The order and eligible social close are inserted in one transaction, only after a successful insert, at hyperliquid-external-fill-sync.ts:654-709; notification is sent only for that returned insert at lines 711-756. Exact fill size, venue price/time/network, external provenance, and reduce-only status remain copied at lines 671-690. Non-closing fills do not get social rows (test lines 419-429); mirrored protection is stored with provenance but has no social row or notification (test lines 431-450).

The frozen fanout contract remains unmodified. The candidate source inner-joins the authoritative order at copy-mirror-candidate-sources.ts:1218-1267, admits only valid Hyperliquid perp rows and preserves the exact decimal source quantity/reduce-only intent at lines 1007-1094, and uses existing follower/destination selection at lines 1044-1083. Durable staging and checkpoint ordering remain unchanged at copy-mirror.ts:2072-2116 and 2352-2382; the follower-lane scheduler remains unchanged at copy-mirror-delivery-order.ts:151-220.

## Strict Checklist Results

| Category | Result | Evidence |
|---|---|---|
| Money loss: wrong account | PASS | Credential attribution query is scoped to credential user and Hyperliquid venue at hyperliquid-external-fill-sync.ts:549-557; inserted order/social rows use that credential's user and ID at lines 659-707. Candidate source also rejects a joined order whose user differs from the social row at copy-mirror-candidate-sources.ts:926-930. |
| Money loss: size | PASS | classifyExternalFill rejects non-finite/non-positive size or price at hyperliquid-external-fill.ts:68-89; ingest preserves fill.sz verbatim in both decimal columns at hyperliquid-external-fill-sync.ts:669-688. Existing assertion: hyperliquid-external-fill-sync.test.ts:388-398. |
| Money loss: side | PASS | Direction/action derivation is explicit for closes, flips, and opens at hyperliquid-external-fill.ts:131-151, with long/short/flip tests at hyperliquid-external-fill.test.ts:109-151. The candidate source uses the authoritative perp side and reduce-only flag at copy-mirror-candidate-sources.ts:1046-1083. |
| Money loss: leverage | N/A | This bounded external-fill path is keyless/read-only and never places or sizes a venue order (hyperliquid-external-fill-sync.ts:29-37). The downstream close candidate is reduce-only and existing leverage execution was not changed (copy-mirror-candidate-sources.ts:1079-1083). No leverage decision is introduced here. |
| Money loss: consent | PASS | Existing matched follower set and destination selection remain in force; only reduce-only closes bypass a disabled open gate, as expressly required by the brief (copy-mirror-candidate-sources.ts:1044-1058). Opens remain gated. No consent or execution path changed. |
| Money loss: attribution | PASS | User, credential, venue, external-origin, and order/social link are retained at hyperliquid-external-fill-sync.ts:659-707; the close candidate carries source user/order and destination follower/credential at copy-mirror-candidate-sources.ts:1052-1093. |
| Parity: stocks and perps | PASS | The approved behavior is perps-specific. Only the two authorized Hyperliquid worker paths and their tests changed; no equity/Alpaca path changed. |
| Parity: entry behavior | PASS | External opens remain private from follower fanout: implementation condition at hyperliquid-external-fill-sync.ts:654-658, 692-695; assertion at hyperliquid-external-fill-sync.test.ts:419-429. |
| Parity: exit behavior | PASS | Eligible closes are reduce-only and atomically linked to one social close; implementation at hyperliquid-external-fill-sync.ts:654-707 and the 51-fill regression at hyperliquid-external-fill-sync.test.ts:538-580. |
| Boundary: empty | PASS | Empty venue fill lists return without moving cursor or inserting rows at hyperliquid-external-fill-sync.ts:464-470; fake Info defaults to an empty list at hyperliquid-external-fill-sync.test.ts:175-185 and empty-fill paths run in the focused suite. |
| Boundary: malformed | PASS | Invalid timestamp is filtered before ordering at hyperliquid-external-fill-sync.ts:466-469; invalid size/price/time is rejected by the pure classifier and tested at hyperliquid-external-fill.test.ts:72-76. |
| Boundary: missing | PASS | Invalid/missing wallet address returns before cursor or venue work at hyperliquid-external-fill-sync.ts:405-410; first-run cursor is seeded before reads at lines 416-435 and tested at hyperliquid-external-fill-sync.test.ts:312-330. Known OID/CLOID rows are left to order sync at hyperliquid-external-fill.ts:48-54, 83-89 and test lines 42-59. |
| Boundary: stale | PASS | Candidate fills must be strictly newer than the observed cursor (hyperliquid-external-fill-sync.ts:466-470); nextWatermarkMs never rewinds (hyperliquid-external-fill.ts:185-201), with out-of-order/empty tests in hyperliquid-external-fill.test.ts. |
| Boundary: partial | PASS | The cap-split tie is replayable and recoverable over three local polls (hyperliquid-external-fill-sync.test.ts:538-580); order plus social insert share a transaction (hyperliquid-external-fill-sync.ts:658-709). |
| Duplication: replay | PASS | Three-poll test leaves exactly 51 orders, 51 linked social rows, and 51 notifications after the final replay (hyperliquid-external-fill-sync.test.ts:561-580). |
| Duplication: retries | PASS | Stable deterministic client ID plus database unique index and onConflictDoNothing prevent a second row; notify follows only the insert winner (hyperliquid-external-fill.ts:92-110; hyperliquid-external-fill-sync.ts:658-712). |
| Duplication: reconciliation | PASS | Existing app orders are matched by OID or CLOID and skipped for row-driven reconciliation (hyperliquid-external-fill-sync.ts:549-589; hyperliquid-external-fill.test.ts:42-59). |
| Duplication: competing workers | PASS, bounded | For the same scanned set, idempotent order insertion, transactional social publication, and notify-after-created prevent duplicate effects; the durable unique index is at orders.ts:393-397. The per-instance single-flight guard is at hyperliquid-external-fill-sync.ts:331-333. The local regression is sequential, not a divergent live-snapshot or multi-process exercise; no claim about the 500-fill scan or live replica behavior is made. |

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

Historical incident attribution, copy-enabled live follower proof, and production latency remain release proof, not local patch acceptance claims. The 500-fill scan-depth/pagination risk is explicitly out of scope. No production/live service, credentials, wallet, signer, or order submission was used.
