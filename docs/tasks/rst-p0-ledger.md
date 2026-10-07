# RST P0 Orchestration Ledger

Controller-owned coordination state for RST P0. This ledger does not replace
the existing `TASKS.md` or `tasks.json`; only the controller updates it. Do not
infer ticket titles, scope, dependencies, product behavior, or acceptance
criteria.

- [x] (commit `4190d17c`; verified `verify-RST-001.md`, STRICT, 2 rounds, ACCEPT; bounded priority, reserve, FIFO, timeout, and lane-order behavior passed clean-tree gates) RST-001: Scope: add bounded close/protection priority and reserved capacity to the existing Hyperliquid scheduler and delivery lanes; Acceptance/proof: deterministic scheduler and lane-order tests plus canonical gates, with live latency targets retained as release proof; Owner: mirror-delivery coder; Status: ACCEPTED
- [x] (commit `4190d17c`; verified `verify-RST-002.md`, STRICT, 2 rounds, ACCEPT; late-close durability, stale-open disposition, restart replay, claim contention, and exact-once delivery passed clean-tree gates) RST-002: Scope: prevent late wallet fills from disappearing before a durable outcome, while preserving old-open eligibility and exact-once identity; Acceptance/proof: late-close and stale-open RED/green tests plus replay guards and canonical gates; Owner: mirror-delivery coder; Status: ACCEPTED
- [x] (commit `1d2b6369`; verified `verify-RST-003.md`, STRICT, 1 round, ACCEPT; 51 tied closes survive the cap boundary exactly once across replay) RST-003: Scope: recover all external closes across an equal-timestamp ingest-cap boundary without duplicate durable events; Acceptance/proof: 51 tied closes survive two polls exactly once plus canonical gates; Owner: close-correctness coder; Status: ACCEPTED
- [x] (commit `1d2b6369`; verified `verify-RST-004.md`, STRICT, 1 round, ACCEPT; partial stop alerts preserve exact delta, status, venue time, and no-repeat behavior) RST-004: Scope: notify a newly persisted partial RST stop-loss execution with partial status, venue time, and exact delta without duplicate alerts; Acceptance/proof: partial-stop RED/green and unchanged-poll tests plus canonical gates; Owner: close-correctness coder; Status: ACCEPTED

## Decisions

Record dated decisions and open questions with their affected ticket, owner,
state, and evidence. Unapproved product or money decisions remain pending.

| Date | Affected ID | Decision or question | Owner | State | Evidence |
|---|---|---|---|---|---|
| 2026-09-12 | RST-001 through RST-004 | Detached worktrees are required because the user's direct instruction in this session overrides `CLAUDE.md`'s repository preference. Every numbered brief must supply the controller-assigned detached worktree's absolute filesystem path. | Controller | CONFIRMED | User's direct instruction and this setup brief. |
| 2026-09-12 | RST-001 through RST-004 | Verifier model is Luna 5.6, max reasoning. | Controller | CONFIRMED | User-directed setup brief. |
| 2026-09-12 | RST-001 through RST-004 | All unspecified product and money decisions remain pending; no ticket scope, title, dependency, or acceptance criterion is inferred. | User and controller | PENDING | No such approval is present in this setup brief. |
| 2026-09-12 | RST-001 through RST-004 | The user's request authorizes bounded offline fixes for the four documented P0s. It does not authorize production data, live orders, deployment, merge, or money movement. | Controller | CONFIRMED | User request and master backlog. |
| 2026-09-12 | RST-001 and RST-002 | Implement the reproducible scheduler and late-wallet-fill gaps without widening historical-open eligibility or claiming the reported production incident is fully attributed. Live latency and the missing incident tuple remain release proof. | Controller | CONFIRMED | `plan-mirror-delivery.md`; planner evidence at base `93f7b8d8`. |
| 2026-09-12 | RST-003 and RST-004 | Sequence close correctness after the mirror-delivery contract. No schema migration, external-open mirroring, notification schema, or production enablement is authorized. | Controller | CONFIRMED | `plan-close-correctness.md`; planner evidence at base `93f7b8d8`. |
| 2026-09-12 | RST-001 and RST-002 | The canonical gate must run before `check-types`: the DB typecheck emits six ignored `packages/db/dist/**/*.test.js` files that duplicate 51 passes and 6 skips if discovered afterward. | Controller | CONFIRMED | Clean merged-tree run: 5,181 pass, 40 skip, 0 fail, 15,223 expectations across 323 files; both round-2 reports. |
| 2026-09-12 | RST-004 | The real positions-router contract exposed an aggregate Bun mock collision: the existing `perp-trigger-router.test.ts` process-wide Hyperliquid mock omits `createHyperliquidInfoClient`. Authorize that existing test file only to add the missing mock export; no production route, helper, config, or broader harness change. | Controller | CONFIRMED | Coder stop report and isolated passing positions contract in `close-coder.md`. |
| 2026-09-12 | RST-001 through RST-004 | Contributor delivery ends at an open non-draft PR. Vercel project access and preview deployment are maintainer-owned and are not a completion gate for this contributor branch. | User | CONFIRMED | User instruction; PR #265 Vercel statuses report missing project membership. |

## Status

`UNSCOPED` means user-approved scope or acceptance criteria are not recorded.
`READY` means a numbered brief records approved scope, acceptance criteria,
owner, exact base SHA, controller-assigned absolute detached worktree path,
owned paths, and verification commands. `CODING` means the assigned coder is
working within that brief. `VERIFYING` means an independent verifier is
reviewing the bounded diff. `ACCEPTED` requires an `ACCEPT` report, required
proof, and explicit user confirmation. `BLOCKED` means a required decision,
evidence item, or precondition prevents progress. Code or tests alone do not
complete a ticket.

| ID | Current state | Owner | Evidence/report link |
|---|---|---|---|
| RST-001 | ACCEPTED | Mirror-delivery coder `01a095da-a662-7ee1-9170-a9ef7dacd58d`; verifier `01a09612-59cc-7cc0-8a05-bcd643c9ce29` | Integrated as `4190d17c`; [round-2 STRICT ACCEPT](reviews/verify-RST-001.md). Live p95 and close latency remain release proof. |
| RST-002 | ACCEPTED | Mirror-delivery coder `01a095da-a662-7ee1-9170-a9ef7dacd58d`; verifier `01a09612-59cc-7cc0-8a05-bcd643c9ce29` | Integrated as `4190d17c`; [round-2 STRICT ACCEPT](reviews/verify-RST-002.md). Historical incident attribution remains release proof. |
| RST-003 | ACCEPTED | Close-correctness coder `01a0966e-38d1-79f3-b059-c954763f754e`; verifier `01a09691-2997-74a1-aedc-c2c5e0f7d7c6` | Integrated as `1d2b6369`; [round-1 STRICT ACCEPT](reviews/verify-RST-003.md). Historical attribution and the 500-fill scan-depth risk remain release proof/out of scope. |
| RST-004 | ACCEPTED | Close-correctness coder `01a0966e-38d1-79f3-b059-c954763f754e`; verifier `01a09691-2997-74a1-aedc-c2c5e0f7d7c6` | Integrated as `1d2b6369`; [round-1 STRICT ACCEPT](reviews/verify-RST-004.md). Copy-enabled live follower proof remains a release check. |

## Pipeline

Current pipeline state: **all four codeable P0 groups ACCEPTED; clean merged-tree
gate is 5,184 pass, 40 skip, 0 fail, 15,247 expectations across 324 files;
typecheck 11/11; lint exit 0 with 23 existing warnings. Contributor PR #265 is
OPEN, non-draft, and mergeable. Repository-owned GitHub CI run `34708608912`
passed its build-and-test and Postgres migration jobs at product/test head
`773b002e`; this final status-only ledger commit changes no product or test
file. Vercel preview permission is maintainer-owned and non-actionable.
Operational/live release proof remains separate.**

1. The controller records approved decisions and prepares a numbered brief
   containing the exact base SHA, controller-assigned absolute detached
   worktree path, exact owned paths, scope, acceptance criteria, and
   verification commands. Only then may a ticket become `READY`.
2. The coder works only at the assigned detached worktree and exact base SHA,
   changes only the brief's owned paths, and follows the checked-in coder
   gates. The coder does not edit this ledger and never uses real credentials,
   production data, live order submission, or production execution flags.
3. An independent verifier uses Luna 5.6 at max reasoning in a fresh context,
   reads the full bounded diff and applicable repository rules, applies the
   separate strict checklist, runs focused checks, and records evidence from
   the reviewed tree in its assigned report under `docs/tasks/reviews/`.
4. On `REJECT`, only evidenced corrections return to the coder. The verifier
   re-checks the corrected diff and confirms no unrelated source changed;
   coder self-report is not verifier evidence.
5. Only after an `ACCEPT` report, required proof, and explicit user
   confirmation may the controller mark a ticket `ACCEPTED` and proceed with
   commit or release bookkeeping. Keep local fixture evidence, operational
   cutover requirements, and live-release proof distinct.
