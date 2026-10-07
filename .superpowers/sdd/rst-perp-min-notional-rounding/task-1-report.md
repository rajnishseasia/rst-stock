# Task 1: Permit the smallest safe minimum-notional round-up

## Status

DONE. The non-ratio perp open decision now permits the smallest venue-precision
quantity whose exact aggressive IOC payload clears the shared $10 minimum, but
only when the exact payload remains within the independent hard cap. Ratio
sizing remains strictly non-upsizing.

## TDD evidence

The focused regressions were added before any production edit:

- The observed CASHCAT shape: USD target $10, $10.55 cap, mark `0.21408`,
  long, `szDecimals=0`, leverage 2, sufficient collateral, daily cap 1, and
  no existing mirror. It expects `sizeCoin: "45"` and `orderDollars: 10.1151`.
- The same shape with a `$10.10` cap, proving the minimum round-up is refused
  when the next venue quantity would exceed the cap.
- A decimal-helper regression for exact quotient ceilings at 3 and 0 venue
  decimals.

### RED

Exact command:

```text
bun test apps/worker/src/services/__tests__/copy-mirror-round5.test.ts
```

Exact result:

```text
29 pass
1 fail
106 expect() calls
Ran 30 tests across 1 file. [11.57s]
```

The only failure was the new CASHCAT regression. The current implementation
returned `{ action: "skip", reason: "below-min-notional" }` instead of the
expected placement. This is the required feature-missing failure, not a test
or setup error.

### GREEN

Exact focused command:

```text
bun test apps/worker/src/services/__tests__/copy-mirror-round5.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-decimal.test.ts
```

Result:

```text
33 pass
0 fail
113 expect() calls
Ran 33 tests across 2 files. [1.65s]
```

## Implementation

`divideDecimalCeil` was added to the existing perp decimal module. It performs
positive decimal division and ceiling in bigint coefficient space, then
revalidates the formatted result in the shared safe-perp domain.

`decidePerpMirror` now first validates the existing floor-sized quantity. Only
when the sizing mode is non-ratio and that exact payload is below the venue
minimum does it derive the exact minimum-clearing size from the aggressive IOC
limit. The same exact venue validator then enforces both the $10 floor and the
independent hard cap. Margin and daily-cap checks run against the final size.
The ratio branch is untouched by the round-up path.

For the observed shape, `aggressivePrice("0.21408", "long", 0, 0.05)` is
`"0.22478"`. The existing floor is 44 contracts, worth `$9.89032`; the
smallest whole-contract quantity clearing $10 is 45, worth `$10.1151`, which
fits the `$10.55` cap.

## Broader verification

```text
bun test apps/worker/src/services/__tests__/copy-mirror.test.ts
304 pass, 0 fail, 757 expect() calls
Ran 304 tests across 1 file. [1.66s]

All apps/worker/src/services/__tests__/copy-mirror*.test.ts files
895 pass, 0 fail, 2069 expect() calls
Ran 895 tests across 40 files. [2.68s]

bun test apps/worker/src
1295 pass, 0 fail, 3140 expect() calls
Ran 1295 tests across 60 files. [4.03s]

bun run --filter @trade-bot/worker typecheck
pass, exited with code 0

bunx oxlint apps/worker/src/services/copy-mirror-perp-decisions.ts apps/worker/src/services/copy-mirror-perp-decimal.ts apps/worker/src/services/__tests__/copy-mirror.test.ts apps/worker/src/services/__tests__/copy-mirror-round5.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-decimal.test.ts
pass, exit code 0

git diff --check
pass, exit code 0; Git emitted only LF-to-CRLF working-copy warnings
```

The complete copy-mirror command was run by enumerating the matching files in
PowerShell and invoking `bun test` with that file array, because Bun does not
expand a quoted wildcard path as a test filter.

## Files changed

- `apps/worker/src/services/copy-mirror-perp-decisions.ts`
- `apps/worker/src/services/copy-mirror-perp-decimal.ts`
- `apps/worker/src/services/__tests__/copy-mirror-round5.test.ts`
- `apps/worker/src/services/__tests__/copy-mirror-perp-decimal.test.ts`
- `apps/worker/src/services/__tests__/copy-mirror.test.ts` (existing minimum
  skip assertions now use an explicit cap that makes the round-up unsafe)
- This report file.

The pre-existing unrelated edits in `apps/web-v2/next-config.test.ts`,
`apps/web-v2/next-env.d.ts`, and `apps/web-v2/next.config.ts` were preserved and
were not staged.

## Self-review and concerns

- The round-up condition is explicitly `c.sizingMode !== "ratio"`; the existing
  ratio-below-floor regression remains green.
- Minimum and cap decisions use exact decimal helpers and the existing bigint
  venue validator. No floating-point minimum or hard-cap comparison was added.
- The validator is run again for the rounded quantity, so a cap failure remains
  a safe skip. The final quantity is used for the existing numeric safety,
  margin, daily-cap, and placement checks.
- No database, configuration, service, browser, live-order, deployment, push,
  PR, or merge operation was performed.
- No unresolved functional concerns. The only verification note is Git's
  existing line-ending warning on these working-copy files.

## Fix Round 1

### Review findings addressed

The review identified that a caller cap above `$10.55` could still authorize a
larger open, and that non-ratio budgets were calculated with binary floating
point before the exact floor helper. This round adds an immutable effective
`"10.55"` cap for every `decidePerpMirror` open sizing mode, while retaining a
lower caller cap when one is supplied. It also derives USD and percentage
budgets from exact decimal strings before `divideDecimalFloor`.

### TDD RED

Before the production fix, these regressions were added to
`copy-mirror-round5.test.ts`: a caller cap of `$1000` must still place only the
`0.1 @ $105 = $10.50` long payload, a coarse `$5.985` venue increment must skip
when its minimum-clearing `2 @ $5.985 = $11.97` payload exceeds `$10.55`, and a
ratio source must clamp to `$10.55` without being upsized beyond its source
quantity. Exact helper tests were also added for decimal minimum selection and
percentage multiplication.

Command:

```text
bun test apps/worker/src/services/__tests__/copy-mirror-round5.test.ts
```

Result before the production fix:

```text
30 pass
3 fail
109 expect() calls
Ran 33 tests across 1 file. [1.88s]
```

The three failures were the expected missing behavior: the caller-cap test
received `sizeCoin: "0.476", orderDollars: 49.98`; the coarse increment test
received `action: "place", sizeCoin: "2", orderDollars: 11.97`; and the ratio
test received `sizeCoin: "1", orderDollars: 105`.

### Implementation

- Added the immutable `MIRROR_PERP_MAX_ORDER_DOLLARS_USD = "10.55"` safety
  ceiling in `copy-mirror-perp-decisions.ts` and compute the effective cap with
  exact decimal comparison before either sizing branch.
- Applied the effective cap to ratio sizing without adding any minimum-notional
  round-up behavior to ratio mode.
- Added exact `minPositiveDecimal` and `percentageDecimal` primitives. The
  unbounded decimal parser accepts finite numeric strings, including the
  scientific notation emitted by `String(number)`, so a very large caller cap
  can safely resolve to the immutable ceiling without a floating comparison.
- Replaced non-ratio `Math.min` and percentage multiplication before the floor
  with exact decimal target and budget derivation. The final venue validator is
  still run with the effective cap for both the original floor and any safe
  minimum-notional candidate.
- Updated existing perp decision and opening-execution expectations to reflect
  the new independent ceiling while retaining their sizing, margin, daily-cap,
  idempotency, exact-payload, and close coverage.

### GREEN and broader verification

Focused regression and decimal primitive tests:

```text
bun test apps/worker/src/services/__tests__/copy-mirror-round5.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-decimal.test.ts
38 pass
0 fail
120 expect() calls
Ran 38 tests across 2 files. [1.89s]
exit code: 0
```

Complete decision/worker coverage:

```text
bun test apps/worker/src/services/__tests__/copy-mirror.test.ts
304 pass
0 fail
757 expect() calls
Ran 304 tests across 1 file. [1.79s]

All apps/worker/src/services/__tests__/copy-mirror*.test.ts files
900 pass
0 fail
Ran 900 tests across 40 files. [2.70s]

bun test apps/worker/src
Ran 1300 tests across 60 files. [2.97s]
exit code: 0

bun run --filter @trade-bot/worker typecheck
@trade-bot/worker typecheck: Exited with code 0

bunx oxlint apps/worker/src/services/copy-mirror-perp-decisions.ts apps/worker/src/services/copy-mirror-perp-decimal.ts apps/worker/src/services/__tests__/copy-mirror.test.ts apps/worker/src/services/__tests__/copy-mirror-round5.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-decimal.test.ts
exit code: 0

git diff --check
exit code: 0; Git emitted only existing LF-to-CRLF working-copy warnings
```

### Files changed

- `apps/worker/src/services/copy-mirror-perp-decisions.ts`
- `apps/worker/src/services/copy-mirror-perp-decimal.ts`
- `apps/worker/src/services/__tests__/copy-mirror-round5.test.ts`
- `apps/worker/src/services/__tests__/copy-mirror-perp-decimal.test.ts`
- `apps/worker/src/services/__tests__/copy-mirror.test.ts`
- This report file.

The unrelated unstaged edits in `apps/web-v2/next-config.test.ts`,
`apps/web-v2/next-env.d.ts`, and `apps/web-v2/next.config.ts` were preserved and
were not staged.

### Self-review and concerns

- The effective cap is exact and independent of the caller cap: lower caller
  caps remain effective, while larger or scientific-notation caps resolve to
  `$10.55`.
- Coarse venue precision can no longer round a sub-minimum request above the
  immutable cap. Ratio sizing remains strictly non-upsizing, including when
  its caller cap is larger.
- Non-ratio USD, `pct`, and `pct_equity` target/cap arithmetic reaches the exact
  bigint floor helper as decimal strings. The exact payload validator remains
  the final safety gate before margin and daily-cap checks.
- No database, configuration, service, browser, live-order, deployment, push,
  PR, or merge operation was performed. No unresolved functional concerns were
  found. Git's only note is the existing line-ending warning.
