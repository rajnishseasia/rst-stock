# RST Strict Audit Checklist

Verifier-owned, read-only audit criteria for a bounded ticket review. Apply
each condition individually and record one result (`PASS`, `FAIL`, or `N/A`)
and current evidence in the assigned report. Cite a file and line or a test
from the reviewed tree for every result. Give a reason for each `N/A`; missing
evidence is not a pass. Do not infer product requirements from this checklist
or edit this checklist during a review.

## Money-loss

- Wrong account: determine whether a reviewed path can act on the wrong account
  or whether that case is prevented or safely rejected.
- Size: determine whether size handling is supported by the approved brief and
  whether invalid or missing values are prevented or safely rejected.
- Side: determine whether side and position direction follow the approved
  action and whether ambiguous or invalid values are safely rejected.
- Leverage: determine whether leverage is constrained by the approved brief
  and whether invalid or missing values are safely rejected.
- Consent: determine whether required consent is enforced at the relevant
  stages and cannot be bypassed by retries or replay.
- Attribution: determine whether user, account, source, and follower identity
  remain correctly scoped through the reviewed path.

## Parity

- Stocks and perps: determine whether any behavior difference is intentional
  and supported by the approved brief and current evidence.
- Entry behavior: determine whether entry behavior is intentional, supported,
  and consistent across applicable paths.
- Exit behavior: determine whether exit behavior is intentional, supported,
  and consistent across applicable paths.

## Boundaries

- Empty state: empty inputs or result sets fail safely.
- Malformed state: malformed values fail safely without unsafe coercion.
- Missing state: missing records or fields fail safely.
- Stale state: stale inputs or state fail safely and cannot cause an unsafe
  action.
- Partial state: partial writes, fills, or updates fail safely and remain
  recoverable or explicitly reported.

## Duplication

- Replay: replayed events do not create unsafe duplicate effects.
- Retries: retries do not duplicate externally visible or financial effects.
- Reconciliation: repeated reconciliation is idempotent or safely deduplicated.
- Competing workers: concurrent workers cannot create unsafe duplicate effects
  or lose required work.
