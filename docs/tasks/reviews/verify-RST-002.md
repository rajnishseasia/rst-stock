# Cold Verification Report: RST-002

- **Verdict:** REJECT
- **Reviewed commit:** `398c29817060263e189f49a4daaaef1531a2a8b0`
- **Base:** `c2e98ec7ed263c7a6a12a810f790a6c40aad0818`
- **Mode:** Strict, cold verifier; round 1
- **Scope:** Wallet-source late-close staging, stale/future open handling, cursor safety, and shared delivery scheduling. No source/test edits or production/live operations were performed during verification.

The wallet changes preserve the five-minute open eligibility, stage attributed late closes, durably terminalize stale opens before advancing the cursor, hold the cursor for future/unresolved inputs, and keep lost claims lane-local. The report is nevertheless REJECT: the shared Hyperliquid scheduler has the same-priority FIFO defect documented in RST-001, and the new replay test stubs out the durable staging method instead of proving replay/delivery behavior across restart and claim contention.

## Findings

### RST-002-F1 — Blocking shared defect: equal-priority FIFO is violated

`packages/hyperliquid/src/client.ts:235` admits the first same-priority request that fits, not necessarily the sequence head. A later lighter close can therefore pass an earlier heavier close; sustained small close traffic can starve the earlier wallet close. Wallet perp execution creates its client through `apps/worker/src/services/copy-mirror.ts:4527`, and the client installs this scheduler at `packages/hyperliquid/src/client.ts:911`. The implementation documents that scheduler as process-local at `packages/hyperliquid/src/client.ts:292`, but its same-class fairness is not preserved.

**Required correction:** use strict FIFO within each priority class, with no same-class bypass when the head cannot fit, and add the heavy-head/lighter-following fake-clock regression specified in RST-001-F1. This is a shared correction and blocks both RST-001 and RST-002.

### RST-002-F2 — Blocking coverage gap: replay test does not exercise durable dedupe or delivery

`apps/worker/src/services/__tests__/copy-mirror-durability.test.ts:342` names a replay scenario, but at `:376` replaces production `stageDeliveryBatch` with a `Set`-backed stub and at `:386` forces `loadDueDeliveries` to return no work. It runs two polls on one harness; it does not restart a poller, contend on a claim, or assert one venue call. The set itself absorbs duplicate keys, so the assertion at `:392` cannot detect a regression in production conflict handling. Production does have a follower/source unique key (`packages/db/src/schema/copy-mirror-state.ts:60`) and `stageDeliveryBatch` uses `onConflictDoNothing` (`apps/worker/src/services/copy-mirror.ts:2376`); those code facts do not substitute for the required regression. The stage-window retry test (`copy-mirror-durability.test.ts:1212`) also uses an in-memory `Set` in its fake transaction and does not deliver an order.

**Required correction:** add a deterministic test that invokes the production staging and delivery path without replacing `stageDeliveryBatch`; persist the inbox across a new poller instance, replay the same wallet source page, include claim contention, and assert one durable `(follower, source item)` identity/outcome and exactly one fake venue submission. The test must fail if production replay dedupe or stable client-order identity is broken. Keep the fake database's uniqueness behavior explicit; do not let a test-local Set stand in for the method under test.

## Requirement And TDD Evidence

| Requirement | Result | Evidence |
|---|---|---|
| Wrong priority, capacity, and abort scheduler cases | PASS for exercised cases | Fake transport assertions would fail if close priority/order, the 1,100 ceiling, or queued abort handling regressed (`packages/hyperliquid/src/client.test.ts:190`, `:216`, `:258`, `:149`, `:240`). They do not cover same-priority FIFO; see RST-002-F1. |
| Late wallet close not dropped by open-age logic | PASS | The six-minute-old close test would fail if open-age filtering discarded the close or removed its reduce-only/exposure attribution (`apps/worker/src/services/__tests__/hl-wallet-copy-poller.test.ts:408`, `:448`, `:451`); the age helper exempts closes at `apps/worker/src/services/__tests__/copy-mirror-delivery-order.test.ts:173`. |
| Old wallet open is durably terminal before cursor advance and cannot reach venue | PASS | The test would fail if the old open were due, terminalized after the cursor, or caused venue creation (`apps/worker/src/services/__tests__/hl-wallet-copy-poller.test.ts:460`, `:500`, `:503`, `:506`). |
| Future wallet open is terminalized, cursor held, and no venue call | PASS | The test would fail if the future open advanced the cursor, remained due, or created a venue client (`apps/worker/src/services/__tests__/hl-wallet-copy-poller.test.ts:512`, `:532`, `:533`, `:534`, `:535`). |
| Shared five-minute and fifteen-minute bounds remain unchanged | PASS | The five-minute boundary assertion would fail if eligibility changed (`apps/worker/src/services/__tests__/copy-mirror-delivery-order.test.ts:161`); the shared fifteen-minute guard and zero venue calls are covered at `apps/worker/src/services/__tests__/copy-mirror-durability.test.ts:638` and `:703`. |
| Cursor advances only after durable staging or explicit terminal outcome | PASS for tested paths | Event-order assertions would fail if late-close/stale-open staging moved after cursor advance (`apps/worker/src/services/__tests__/hl-wallet-copy-poller.test.ts:448`, `:500`); the future event and unresolved claim assert cursor hold at `:533` and `:567`. Production terminal staging is at `apps/worker/src/services/copy-mirror.ts:2292` and `:2328`. |
| Independent closes lead without overtaking same-follower prerequisite opens | PASS | The lane test would fail if an independent close were delayed or a follower's close overtook its prerequisite open (`apps/worker/src/services/__tests__/copy-mirror-delivery-order.test.ts:25`, `:74`); concurrency and in-follower order are covered at `:82` and `:105`. |
| Lost claim isolates one follower lane | PASS | The helper test would fail if a false claim were ignored or blocked follower B (`apps/worker/src/services/__tests__/copy-mirror-delivery-order.test.ts:130`). Compare-and-set and lost-batch tests cover claim wins/losses (`apps/worker/src/services/__tests__/copy-mirror-durability.test.ts:754`, `:774`, `:789`). |
| Exact-once source replay and no duplicate delivery/venue call | FAIL for required regression coverage | The replay harness substitutes a `Set` for `stageDeliveryBatch` and disables due delivery (`copy-mirror-durability.test.ts:376`, `:386`). See RST-002-F2. |
| Shared scheduler starvation/timer behavior | FAIL | Same-priority bypass is present at `client.ts:235`; timeout wakeup/cleanup is not directly asserted by `client.test.ts`. See RST-001-F1 and F2. |

## Strict Checklist

| Checklist item | Result | Evidence / N/A reason |
|---|---|---|
| Money-loss: wrong account | PASS | The group is keyed by follower and wallet, destination is read from that follower's follow, and the candidate keeps that destination credential (`apps/worker/src/services/hl-wallet-copy-poller.ts:331`, `:362`, `:366`, `:474`; durable row preserves it at `apps/worker/src/services/copy-mirror.ts:2297`). |
| Money-loss: size | PASS | Candidate construction rejects non-finite/non-positive sizing values and carries the selected sizing mode/value forward (`apps/worker/src/services/hl-wallet-copy-poller.ts:189`, `:190`, `:220`, `:221`). |
| Money-loss: side | PASS | Source `dir` determines open/close, source `side` determines perp direction, and close requires attributed exposure and sets reduce-only (`apps/worker/src/services/hl-wallet-copy-poller.ts:199`, `:202`, `:204`, `:229`); late-close fixture verifies the exposure payload at `apps/worker/src/services/__tests__/hl-wallet-copy-poller.test.ts:451`. |
| Money-loss: leverage | PASS | User and follow leverage are validated before scanning and again when building the candidate (`apps/worker/src/services/hl-wallet-copy-poller.ts:191`, `:195`, `:376`). |
| Money-loss: consent | PASS | Wallet polling requires runtime gates (`apps/worker/src/services/hl-wallet-copy-poller.ts:263`, `:296`), an auto-mirror-eligible follow (`:297`), and an enabled destination with credential (`:366`). |
| Money-loss: attribution | PASS | Follower/wallet grouping and the stable wallet+fill-tid source identity are preserved in the candidate (`apps/worker/src/services/hl-wallet-copy-poller.ts:331`, `:206`, `:213`); the staged close test checks the follower-specific source id at `apps/worker/src/services/__tests__/hl-wallet-copy-poller.test.ts:445`. |
| Parity: stocks and perps | N/A | This bounded addition is for Hyperliquid wallet perps; no stock source route is changed (`/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p0-orchestrator/briefs/plan-mirror-delivery.md:65`). |
| Parity: entry behavior | PASS | Five-minute wallet-open eligibility remains enforced; old opens are terminal and not due (`copy-mirror-delivery-order.test.ts:161`, `hl-wallet-copy-poller.test.ts:460`). |
| Parity: exit behavior | PASS | Close candidates bypass the open-age filter and require attributed exposure/reduce-only execution (`copy-mirror-delivery-order.test.ts:173`, `hl-wallet-copy-poller.test.ts:408`, `:451`). |
| Boundaries: empty state | PASS | Empty wallet scans return before candidate staging (`apps/worker/src/services/hl-wallet-copy-poller.ts:442`); empty external candidate batches also return at `apps/worker/src/services/copy-mirror.ts:2259`. |
| Boundaries: malformed state | PASS | Non-object/non-finite-time fills and missing/invalid stable tids hold the cursor instead of staging (`apps/worker/src/services/hl-wallet-copy-poller.ts:419`, `:428`); unusable timestamps return no event time (`apps/worker/src/services/__tests__/copy-mirror-delivery-order.test.ts:196`). |
| Boundaries: missing state | PASS | Candidate construction rejects missing follower, follow, credential, timestamp, or transaction identity (`apps/worker/src/services/hl-wallet-copy-poller.ts:180`, `:187`); unknown wallet-open time fails closed at `apps/worker/src/services/__tests__/copy-mirror-delivery-order.test.ts:173`. |
| Boundaries: stale state | PASS | Five-minute open bound and close exemption are explicit (`copy-mirror-delivery-order.test.ts:161`, `:173`); stale opens are terminal before cursor advance (`hl-wallet-copy-poller.test.ts:500`). |
| Boundaries: partial state | PASS | Active/unresolved delivery prevents terminalization and cursor advance (`hl-wallet-copy-poller.test.ts:541`, `:567`); staging throws `EAGAIN` when an unresolved row cannot be safely resolved (`copy-mirror.ts:2343`). |
| Duplication: replay | FAIL | The replay test replaces the production staging method with a Set and has no delivery after restart (`copy-mirror-durability.test.ts:376`, `:386`). See RST-002-F2. |
| Duplication: retries | PASS | Delivery transient/syncing outcomes are requeued rather than completed (`apps/worker/src/services/__tests__/copy-mirror-durability.test.ts:485`, `:511`); an existing Hyperliquid retry test reconciles the deterministic cloid and asserts no repost (`apps/worker/src/services/__tests__/copy-mirror.test.ts:4478`, `:4515`, `:4516`). |
| Duplication: reconciliation | PASS | Existing Hyperliquid recovery checks venue state for the deterministic cloid and returns recovered without another venue submission (`apps/worker/src/services/__tests__/copy-mirror.test.ts:4478`, `:4502`, `:4515`, `:4516`). This does not fill the source replay integration gap in F2. |
| Duplication: competing workers | PASS | A lost CAS claim is handled without processing that row, and another lane progresses (`copy-mirror-durability.test.ts:774`, `:789`; `copy-mirror-delivery-order.test.ts:130`). |

## Ownership, Operations, And Gates

The reviewed commit is exactly the requested SHA and has parent `c2e98ec7ed263c7a6a12a810f790a6c40aad0818`. Its complete base-to-commit diff contains eight owned files, 1,212 insertions and 80 deletions: `packages/hyperliquid/src/client.ts`, its test, `apps/worker/src/services/copy-mirror-delivery-order.ts`, its test, `apps/worker/src/services/copy-mirror.ts`, `apps/worker/src/services/hl-wallet-copy-poller.ts`, its test, and `apps/worker/src/services/__tests__/copy-mirror-durability.test.ts`. No schema or migration path changed. The worktree was clean before report creation; no unrelated edits were present.

- Focused brief command: 229 pass, 0 fail, 545 expect calls.
- Canonical `bun test`: 5,228 pass / 46 skip / 0 fail across 329 files. Supplied baseline: 5,165 / 40 / 0; no failing names in either result.
- `bun run check-types`: 11/11 targets successful (10 cache hits; worker target executed).
- `bun run lint`: exit 0, 23 warnings; none in changed files.
- `git diff --check` from base to reviewed commit: clean.
- Tests used fake transport/database fixtures; no production data, credentials, live broker, signing, or live order submission was used. No live p95 or close-latency measurement was made.

The brief explicitly states that the historical RST-002 tuple is missing and is not attributed to this wallet regression (`/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p0-orchestrator/briefs/plan-mirror-delivery.md:30`, `/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p0-orchestrator/briefs/plan-mirror-delivery.md:34`). It remains outstanding release proof, along with post-deployment verification of four-follower p95 source-fill-to-submit under 10 seconds, close attempts under 5 seconds, and alerts for opens waiting over 10 seconds (`/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p0-orchestrator/briefs/plan-mirror-delivery.md:103`). This deterministic review makes no claim that the historical incident is fixed.

**Corrections required for RST-002:** fix the shared scheduler FIFO defect in RST-001-F1, and add the production-path replay/restart/claim test described in F2. No schema migration, broadened five-minute eligibility, or production investigation is requested.

## Round 2 Verification

- **Verdict:** ACCEPT
- **Reviewed tree SHA:** `343153d58c8ec59a81c9fc7c305e318d74ee736a`
- **Base SHA:** `c2e98ec7ed263c7a6a12a810f790a6c40aad0818`
- **Round:** 2, strict cold verification
- **Model:** Controller launch configuration was `gpt-5.6-luna` / `max`; runtime identity was not independently introspectable by the verifier.
- **Compared with:** round-1 commit `398c29817060263e189f49a4daaaef1531a2a8b0`; correction commit `343153d58c8ec59a81c9fc7c305e318d74ee736a`

### Round-1 Findings Resolved

| Finding | Round-2 result | Current-tree evidence |
|---|---|---|
| RST-002-F1: shared scheduler FIFO bypass | **RESOLVED** | Shared fix in `packages/hyperliquid/src/client.ts:251-263` admits only the sorted priority/sequence head and waits if it cannot fit. The heavy-close/light-close FIFO regression and accepted close/open/background ordering tests are at `packages/hyperliquid/src/client.test.ts:302-333`, `:232-260`, and `:263-299`. |
| RST-002-F2: durable replay and delivery regression missing | **RESOLVED** | `apps/worker/src/services/__tests__/hl-wallet-copy-poller.test.ts:792-874` invokes real `CopyMirrorPoller.stageExternalCandidates` on two poller instances; production `stageExternalCandidates` routes to `stageDeliveryBatch` at `apps/worker/src/services/copy-mirror.ts:2258-2284`, whose actual transactional insert and `(followerUserId, sourceItemId)` conflict target are at `:2352-2382`. The first cursor write fails after the inbox insert (`hl-wallet-copy-poller.test.ts:387-394`); a new wallet/stager instance replays the same fill, and assertions prove two insert attempts yield one persisted identity (`:803-823`). Two actual delivery pollers take synchronized due snapshots (the fake DB barrier is `hl-wallet-copy-poller.test.ts:290-293`, `:326-337`) and contend on the production claim path (`copy-mirror.ts:2097-2119`, `:2543-2562`; test `hl-wallet-copy-poller.test.ts:825-838`); one wins, one durable `completed/placed` outcome remains, and the fake venue is called exactly once. Only `processPerpCandidate` is replaced with the fake venue boundary (`hl-wallet-copy-poller.test.ts:445-466`). The test then calls production `processCandidate` on the persisted candidate; the deterministic client-order identity returns `duplicate` without another submission (`copy-mirror.ts:2941-2958`, `:3092-3106`; test `:832-870`). |

The fake inbox enforces the explicit production conflict target and models the follower/source unique identity by searching its persisted rows (`apps/worker/src/services/__tests__/hl-wallet-copy-poller.test.ts:356-385`); it does not use a test-local `Set` to replace production staging. The fake database models the claim compare-and-set, while the production poll/load/claim/process orchestration remains under test. Thus this is deterministic fixture evidence, not a claim that the in-memory fake is PostgreSQL or cross-process production telemetry.

### Round-1 Accepted Behavior Rechecked

| Behavior | Round-2 result | Current-tree evidence |
|---|---|---|
| Wallet close ordering and attribution | **PASS** | A six-minute-old attributed close is staged before the newer fill/cursor and remains reduce-only with its mirrored exposure (`apps/worker/src/services/__tests__/hl-wallet-copy-poller.test.ts:626-676`). Source closes require attributed exposure and are staged before watermark advancement (`apps/worker/src/services/hl-wallet-copy-poller.ts:453-501`). |
| Stale wallet open handling | **PASS** | The six-minute-old open is durably recorded as `completed/stale-intent` before cursor advance, excluded from due work, and causes no venue-client call (`hl-wallet-copy-poller.test.ts:678-728`; staging at `copy-mirror.ts:2286-2349`). |
| Future wallet open handling | **PASS** | The future open is terminalized, but the source cursor is held, it is not due, and no venue client is created (`hl-wallet-copy-poller.test.ts:730-757`; cursor break at `hl-wallet-copy-poller.ts:494-520`). |
| Cursor safety for unresolved/active deliveries | **PASS** | An old open is not terminalized while another worker owns a pending claim, and the cursor remains held (`hl-wallet-copy-poller.test.ts:759-790`; guarded resolution at `copy-mirror.ts:2321-2348`). Unorderable fills and missing stable identities also hold the cursor (`hl-wallet-copy-poller.ts:418-435`); staging precedes cursor persistence (`:494-520`). |
| Lane-local lost-claim behavior | **PASS** | The helper stops only follower A's lane and still processes follower B (`apps/worker/src/services/__tests__/copy-mirror-delivery-order.test.ts:130-141`); production claim loss returns false to stop that lane (`apps/worker/src/services/copy-mirror.ts:2108-2116`). |

The remaining round-1 PASS/N/A checklist classifications are unchanged. The failed replay and scheduler checklist entries above now pass with current-tree evidence; no schema, migration, stock route, or cross-process scheduler guarantee was added.

### Round-2 Gates And Tree

- Focused four-file command: `bun test packages/hyperliquid/src/client.test.ts apps/worker/src/services/__tests__/copy-mirror-delivery-order.test.ts apps/worker/src/services/__tests__/hl-wallet-copy-poller.test.ts apps/worker/src/services/__tests__/copy-mirror-durability.test.ts` — **233 pass, 0 fail, 580 expect calls**.
- Earlier root `bun test --timeout 30000` output: 5,232 pass / 46 skip / 0 fail, 5,278 tests across 329 files, 15,514 expect calls. **Non-canonical post-typecheck duplicate discovery; not baseline evidence.** It included six ignored generated JavaScript tests under `packages/db/dist`, accounting for +51 pass, +6 skip, and +6 files relative to the clean run.
- Independent clean canonical `bun test --timeout 30000`, with `packages/db/dist` temporarily moved outside the worktree: **5,181 pass / 40 skip / 0 fail**, 5,221 tests across 323 files, 15,223 expect calls. This is +16 pass versus the brief-supplied 5,165 / 40 / 0 baseline, with no change to skips or failures. Round-2 ACCEPT stands because this clean run had zero failures.
- Generated duplicate test paths: `packages/db/dist/__tests__/canonical-ingestion.test.js`, `packages/db/dist/__tests__/copy-trade-leverage-schema.test.js`, `packages/db/dist/__tests__/leaderboard-task3.integration.test.js`, `packages/db/dist/__tests__/timestamp-key-indexes.test.js`, `packages/db/dist/connections/pool.test.js`, and `packages/db/dist/migration-compatibility.test.js`.
- Gate-ordering lesson: `check-types`/`tsc -b` can emit ignored test JavaScript into `packages/db/dist`, which a later root Bun run discovers. Run the canonical suite before build/typecheck artifact emission, or exclude/move generated `dist` while running the canonical suite. The moved directory was restored intact after this clean run.
- `bun run check-types` — **11 successful / 11 total** (all 11 cached on this run).
- `bun run lint` — exit 0, **23 warnings**, none in the changed paths and no increase from the stated warning baseline.
- `git diff --check c2e98ec7ed263c7a6a12a810f790a6c40aad0818 343153d58c8ec59a81c9fc7c305e318d74ee736a` — clean.
- The candidate diff remains exactly the eight assigned source/test paths listed above (1,692 insertions, 80 deletions); no schema or migration path. HEAD is the correction commit with round-1 commit as its parent and no later commit. Before this report append, the only worktree entries were these two authorized untracked reports. No source/test edit, production/live operation, commit, push, or agent use occurred during this verification.

The brief keeps the unavailable historical incident tuple explicitly unlocalized and unattributed (`/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p0-orchestrator/briefs/plan-mirror-delivery.md:30-36`). It remains release proof, along with post-deployment four-follower p95 source-fill-to-submit under 10 seconds, close attempts under 5 seconds, and alerts for opens waiting over 10 seconds (`/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p0-orchestrator/briefs/plan-mirror-delivery.md:103-105`), not a patch-acceptance blocker. No live p95/close-latency measurement or production evidence was gathered here.
