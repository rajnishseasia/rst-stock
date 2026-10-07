# RST P1 Repair Ledger

## Scope

This ledger tracks the 15 P1 rows extracted from the two RST Google Docs tabs.
It records repository work only. A checked box means an independently verified
change was included in the contributor PR; it does not claim deployment or live
production verification.

## Status

- Base: `2fc6ea6860ead27805eaa8d21c318e8fb9bfc27b` (`codex/rst-p0-repairs`)
- Working branch: `codex/rst-p1-repairs`
- Contributor boundary: create a non-draft PR; do not merge, deploy, or operate production.
- Clean baseline: 5,184 pass, 40 skip, 0 fail across 324 files; 15,247 assertions.
- Type baseline: 11/11 packages pass.
- Lint baseline: exit 0 with 23 existing warnings.
- Integrated and accepted: RST-006, RST-009, RST-010, RST-012, RST-013, RST-014, RST-016, and RST-019.
- Current merged gate: 5,263 pass, 47 skip, 0 fail across 328 files; 15,642 assertions; uncached types 11/11; lint exit 0 with 23 existing warnings.
- RST-005, RST-007, RST-008, RST-011, RST-015, RST-017, and RST-018 remain blocked on the evidence or decisions recorded below.

## Pipeline

Each codeable group uses a written bounded brief, a Luna 5.6 Max coder in a
detached worktree, and a fresh Luna 5.6 Max verifier. Coders write the failing
test first, edit only named paths, run the focused and canonical gates, commit,
and never push or edit this ledger. Verifiers inspect the exact diff and current
code, write a report in `docs/tasks/reviews/`, and return ACCEPT or REJECT.
Rejected work returns to the same coder and verifier until accepted. Accepted
commits are integrated here and the merged tree is gated again.

## Decisions

- 2026-09-12: P1 is stacked on the accepted P0 branch while PR #265 awaits maintainer review.
- 2026-09-12: Perps copy trading remains disabled; this work must not enable it.
- 2026-09-12: No agent may use real credentials, reveal private keys, submit orders, or access production data.
- 2026-09-12: Missing product, identity, wallet, or reproduction facts are stop-and-report conditions.
- 2026-09-12: The positions-table Set TP/SL action is full-position-only. It must compare the requested size with the fresh live position using exact decimal semantics and reject a stale or unequal size before persistence or broker submission. Other API callers may retain an explicitly separate partial-protection contract.

## P1 Tasks

- [ ] **RST-005** (owner: RPNL/retry diagnostics) Fix RPNL on initialization.
- [x] (commit `54d0124a`; verified `verify-RST-006.md`, STRICT, 1 round, ACCEPT; fill messages use confirmed prices and distinguish evidenced short closes without the status checkmark) **RST-006** (owner: trade messages) Make trade messages describe the actual execution.
- [ ] **RST-007** (owner: follow/discovery/settings) Correct SOL Decoder leaderboard identity and follow state.
- [ ] **RST-008** (owner: RPNL/retry diagnostics) Diagnose the intermittent retry modal.
- [x] (commits `ad083a1e`, `5698937c`; verified `verify-wallet-identity.md`, STRICT, 2 rounds, ACCEPT; stored-master selection and mismatch setup fail closed without rebinding) **RST-009** (owner: wallet lifecycle) Fix Hyperliquid wallet import/setup.
- [x] (commits `ad083a1e`, `5698937c`; verified `verify-wallet-identity.md`, STRICT, 2 rounds, ACCEPT; export is restricted to the verified stored master and provider errors are sanitized; no live Privy claim) **RST-010** (owner: wallet lifecycle) Fix the HL Export Private Key action.
- [ ] **RST-011** (owner: wallet lifecycle) Restore HL balance data used by copy trading.
- [x] (commit `6b7eabaa`; verified `verify-RST-012.md`, STRICT, 5 rounds, ACCEPT; unresolved custom-auth sessions reach bounded Retry/Reset recovery while funding, copy, export, deposit, signing, and activation stay gated) **RST-012** (owner: wallet lifecycle) Resolve onboarding stuck on reconnect/restoring.
- [x] (commits `adc93de5`, `08d40fec`; verified `verify-RST-013.md`, PRAGMATIC, 2 rounds, ACCEPT; mobile overview links directly to current Perps, Copy Trading, and AI Chat sections) **RST-013** (owner: mobile/workspace/guide) Update the guide for current features.
- [x] (commit `472b9fdd`; verified `verify-RST-014.md`, PRAGMATIC, 1 round, ACCEPT; mobile Hyperliquid rows link to that user's perp fills) **RST-014** (owner: mobile/workspace/guide) Make other users' perp trades discoverable on mobile.
- [ ] **RST-015** (owner: wallet lifecycle) Recover an HL wallet that already exists.
- [x] (commit `0b754e6e`; verified `verify-RST-016.md`, PRAGMATIC, 2 rounds, ACCEPT; behavioral tests prove pane-two tab isolation and reliable close/re-split identity) **RST-016** (owner: mobile/workspace/guide) Isolate split-pane state and make closing reliable.
- [ ] **RST-017** (owner: follow/discovery/settings) Make HL perp signals selectable for manual/automatic copy.
- [ ] **RST-018** (owner: follow/discovery/settings) Save and persist the buying-power setting.
- [x] (commits `c3779a4d`, `62a973a4`, `98c2d438`; verified `verify-RST-019.md`, STRICT, 4 rounds, ACCEPT; positions-table protection fails closed on stale state, validates stock exits, and requires exact fresh full-position sizing before persistence or broker submission) **RST-019** (owner: mobile/workspace/guide) Show and edit SL/TP in every positions table.

## Blockers And Proof

Planner findings, user-owned decisions, live-only checks, and verifier reports
are recorded here as they become concrete. A blocked row remains unchecked.

- **RST-007:** blocked until the authoritative Discord trader, canonical RST
  follow target, and intended displayed identity are supplied. Do not hardcode
  or infer a SOL Decoder mapping from a display name or fixture.
- **RST-005:** strict round-one verification rejected commit `3c593237` for
  cumulative synthetic fill P&L overcount and same-size stale history. The
  synthetic-row defect has a bounded read-side plan, but no current durable
  field proves account-wide history completeness through the live-position
  snapshot. The rejected commit is not integrated; do not use an age cutoff,
  size tolerance, or partial total as a substitute.
- **RST-008:** blocked until the exact retry screen, full error text, route,
  triggering action, device/browser, and reproducible steps identify one of the
  several unrelated retry surfaces.
- **RST-011:** strict verification found that malformed collateral values can
  coerce to zero and concurrent opens can reuse a pre-lock collateral snapshot.
  A bounded parser correction exists, but the complete fix is blocked until
  product defines a durable margin reservation/release policy for PENDING,
  ambiguous, partial, rejected, cancelled, and venue-reflected states.
- **RST-012:** local browser tests cover wallet-not-ready, unresolved subject,
  low balance, exact timeout, repeated Retry/Reset, reset failure, and zero
  account mutation. Live Privy restore remains unverified and is not claimed.
- **RST-015:** wrong-wallet prevention is in strict review, but full duplicate-key
  recovery remains blocked until the provider result can distinguish the same
  verified identity from a wallet owned by another identity. Never match a
  guessed error string or rebind a stored master.
- **RST-017:** local signal classification and manual perp routing tests pass;
  end-to-end proof remains blocked on a known sanitized perp signal and a
  controlled non-production path. Perps copy stays disabled.
- **RST-018:** current behavior autosaves follow sizing on blur or Enter. A code
  change is blocked until product selects autosave versus Save/Apply and the
  owning scope (per follow, destination, or account).
