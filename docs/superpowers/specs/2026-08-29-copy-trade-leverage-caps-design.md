# Copy-Trade Leverage Caps Design

## Goal

Give every user control over the maximum leverage used by automatic
Hyperliquid copy trades without changing manual trading. Manual perp orders keep
their existing per-ticket leverage control. Auto-mirror instead uses one
user-owned global ceiling and an optional lower ceiling on each follow.

This is a real-money risk control. A setting that is absent, stale, malformed,
or unreadable must reduce risk or stop the open; it must never increase
leverage.

## Approved Behavior

- Manual perp leverage remains selected per trade and is not read from these
  settings.
- Every user has `copy_perp_max_leverage`, an integer from `1` through `100`.
- Existing and newly created users start at `1x` until they deliberately choose
  another global copy-trading maximum.
- Every follow has an optional `perp_max_leverage`, also an integer from `1`
  through `100`.
- A null per-follow value means “use my global copy-trading maximum.”
- A per-follow maximum may lower the user’s global maximum but may not raise it.
- Lowering the global maximum transactionally clamps any stored per-follow
  maximum above the new value.
- The leverage applied to an auto-mirrored perp open is:

  ```text
  min(
    source trader leverage or 1x when missing,
    user global copy maximum,
    per-follow maximum when present,
    current Hyperliquid market maximum
  )
  ```

- Reduce-only closes are unaffected. They close the exposure that exists and
  must not be blocked by a newly lowered open-risk ceiling.
- The existing order-notional cap, daily order cap, live/mainnet opt-ins,
  destination consent, position-conflict guard, and venue precision checks all
  remain independent gates.

## Considered Approaches

### 1. Typed columns on `users` and `copy_trade_follows` — selected

Store the global value on the owning user and the override on the owning follow.
This follows the existing schema, gives the API and worker typed values, supports
database checks, and makes ownership queries direct. It is the smallest model
that still provides transactional invariants.

### 2. JSON settings blob

A versioned JSON blob would make future policy additions cheap, but it weakens
database validation and makes a missing or malformed leverage value easier to
misread. It is inappropriate for this single high-risk integer.

### 3. Separate copy-trading policy table

A policy table could eventually hold many portfolio-wide rules. The current
request has one user value and one follow value, so a new joinable aggregate
would add lifecycle and locking complexity without a present benefit.

## Shared Bounds

`packages/types/src/copy-mirror.ts` exports one client-safe constant:

```ts
export const COPY_PERP_LEVERAGE_BOUNDS = {
  min: 1,
  max: 100,
  default: 1,
} as const;
```

The schema, API validation, worker parsing, and web controls all import this
constant. No layer carries a second literal that can drift.

The maximum of `100` is a product input bound, not a promise that a venue market
supports `100x`; the worker always takes the current market maximum as another
ceiling.

## Data Model and Migration

### `users.copy_perp_max_leverage`

- PostgreSQL `integer`
- `NOT NULL`
- default `1`
- check constraint: value between `1` and `100`

The migration’s default backfills every existing user to `1x` without an
unbounded application-side data rewrite.

### `copy_trade_follows.perp_max_leverage`

- PostgreSQL `integer`
- nullable; null means inherit global
- check constraint: null or value between `1` and `100`

PostgreSQL cannot express `perp_max_leverage <= users.copy_perp_max_leverage`
as a row check across two tables. The API serializes both mutations on the user
row, and the worker still takes `min(global, follow)` defensively.

The change is a forward migration after the current migration journal. Applied
migrations remain immutable. The migration SQL, journal entry, and snapshot are
generated/reviewed together using the repository’s existing Drizzle workflow.

## API Contract

The authenticated user-settings router owns the global procedures because the
value belongs to the user rather than any one follow:

```ts
userSettings.getCopyPerpLeverageSettings.query() -> {
  globalPerpMaxLeverage: number;
}

userSettings.setCopyPerpMaxLeverage.mutate({
  globalPerpMaxLeverage: number;
}) -> {
  globalPerpMaxLeverage: number;
  clampedFollowCount: number;
}
```

`follow` and `update` gain:

```ts
perpMaxLeverage?: number | null;
```

The returned follow item gains:

```ts
perpMaxLeverage: number | null;
```

Undefined means “do not change this field.” Null means “clear the override and
inherit the global maximum.” This matches the router’s existing absent-versus-
null contract for optional per-follow protection.

All procedures are protected and scoped to `ctx.userId`.

### Transaction and concurrency rules

`setGlobalPerpMaxLeverage` runs in one transaction:

1. Lock the current `users` row with `FOR UPDATE`.
2. Update the global value.
3. Clamp every non-null per-follow maximum above it to the new global value.
4. Return the saved value and number of clamped rows.

`follow` and `update` lock the same user row before accepting a non-null
per-follow value. They read the current global value in that transaction and
reject a follow maximum above it with `BAD_REQUEST`. The shared user-row lock
serializes a global change against a follow change, so neither mutation can
commit a cross-row policy that the other did not see.

Malformed, fractional, out-of-range, foreign-user, and missing-user requests
are rejected before writing. A missing existing user row is an authorization
failure, not an implicit default.

## Worker Enforcement

### Pure policy

Replace the operator-environment leverage resolver with a DB-backed pure
decision:

```ts
resolveCopyPerpLeverage({
  sourceLeverage,
  userMaxLeverage,
  followMaxLeverage,
  assetMaxLeverage,
}): number
```

Each input is independently normalized to a positive integer. Missing or
invalid source, user, or asset values fail down to `1`. A missing follow value
means no additional ceiling; an invalid non-null follow value fails down to
`1`. The output is always an integer at least `1`.

`COPY_TRADE_AUTOMIRROR_PERPS_MAX_LEVERAGE` no longer determines user exposure.
The operator keeps deployment safety authority through the existing master,
live, perps, mainnet, notional, and daily gates, but does not choose a user’s
copy leverage.

### Staged and current-policy reads

Candidate discovery freezes the source trader's leverage in
`MirrorSourceCandidate.perpLeverage` and snapshots the user-owned ceilings in
`MirrorSourceCandidate.perpUserMaxLeverage` and
`MirrorSourceCandidate.perpFollowMaxLeverage`. This gives every queued delivery
an immutable upper bound from the policy that authorized it. Legacy candidates
without a valid staged user ceiling fail down to `1x`; a missing staged follow
ceiling means inheritance, while an invalid non-null value fails down to `1x`.

Before any non-reduce-only placement or resume, the worker also re-reads:

- the candidate’s exact follow row, scoped to `followerUserId`;
- that follow’s current `perpMaxLeverage`;
- the follower’s current `users.copyPerpMaxLeverage`;
- the current Hyperliquid asset maximum.

The applied ceiling is the minimum of the staged and current policies. Lowering
either user-owned cap takes effect on an already-staged delivery before it can
open exposure. Raising a cap affects only candidates discovered after the
change; it cannot raise leverage on an already-queued intent. The frozen source
leverage remains an additional ceiling.

The existing consent read and leverage-policy read share the same follow/user
observation so deletion, disarming, credential repointing, and risk settings
cannot be interpreted from unrelated snapshots.

If the policy cannot be read or validated, the worker refuses the open and logs
a non-secret structured reason. It does not fall back to an environment maximum.

### Resume parity and audit

A pending order resume uses the same staged-plus-current policy function as a
fresh open and also treats the stored `orders.leverage` as an immutable ceiling.
If the stored order leverage is above the newly effective ceiling, the existing
resume-clamp path lowers and records it before applying leverage at the venue.
It never raises a persisted intent or increases beyond the source, staged user,
staged follow, current user, current follow, or venue ceiling.

The order row continues to store the effective applied leverage. Decision logs
include source, global, follow, venue, and effective values plus user/follow/
source identifiers, but no wallet private key, agent key, token, or credential
payload.

Existing-position protection remains unchanged: if the follower already holds
the coin at a conflicting leverage or margin mode, the open is skipped rather
than rewriting that position’s liquidation profile.

## Web UX

The global control lives in a dedicated **Copy Trading** tab in Settings. It is
not placed in the Perps wallet tab or the manual perp ticket, so a user cannot
mistake it for a manual-trading default. Per-follow controls remain in **Manage
follows**, where desktop and mobile users already choose sizing, destination,
exits, and auto-mirror consent.

### Global control

In the dedicated Copy Trading settings card, render:

- label: `Copy-trading maximum leverage`
- integer input from `1` through `100`
- saved/in-flight/error state
- explanatory copy: `Applies to every automatic perp copy. Leaders and markets
  can use less; no follow can use more.`

The control reads `userSettings.getCopyPerpLeverageSettings`, writes
`userSettings.setCopyPerpMaxLeverage`, and invalidates both the settings and
follow list on success because lowering the global value can clamp follow rows.
The Settings tab resolver accepts `?tab=copy-trading`; the existing four-column
tab strip becomes a responsive five-column strip without making its labels
unreachable on a narrow viewport.

Manage follows shows the current global maximum above its list plus a `Change`
link to `/settings?t=copy-trading`. That summary is not a second editor and
cannot drift into an unsaved value.

### Per-follow control

Each follow row renders a `Perp leverage cap` control:

- empty value / `Use global (Nx)` clears the override to null;
- an integer value from `1` through the current global maximum saves the
  override;
- values above global are blocked client-side and rejected server-side;
- helper text states the effective ceiling;
- the control remains clearly about perp copies even if an Alpaca destination
  is currently selected, so a user can prepare the follow before repointing it.

The arming confirmation includes the effective copy leverage ceiling alongside
destination, sizing, notional/daily limits, and optional exits. It never implies
that the selected maximum is guaranteed: the leader or market may be lower.

Manual trade form labels, state, mutations, and behavior are untouched.

## Error Handling

- API validation errors keep the user’s saved value visible and show the server
  message.
- A failed global mutation does not optimistically rewrite follow rows.
- An unreadable current policy makes the worker skip the open and leaves a
  durable audit outcome/error; it does not place at a guessed leverage.
- A global decrease and follow edit are serialized by the user-row lock.
- A reduce-only close ignores newly lowered open ceilings and retains all
  existing close safety/attribution checks.
- Missing migrations fail startup/query paths visibly; there is no silent
  compatibility fallback that can place leveraged orders.

## Verification

### Database

- Schema and generated migration contain both columns, defaults, nullability,
  and bounds checks.
- Migration journal validation passes from a fresh database and the current
  local database.
- Existing users read `1`; existing follows read null.

### API

- Read/write global setting is user-scoped.
- Bounds and integer validation fail closed.
- Lowering global clamps higher follow values transactionally.
- Per-follow null inherits global.
- Per-follow values above global are rejected.
- Concurrent global/follow updates cannot commit a follow value above global.
- Follow list/follow/update contracts serialize the new field.

### Worker

- Table-driven pure tests cover every minimum combination and invalid input.
- Fresh open and pending-order resume use identical policy inputs.
- Lowering a global or follow cap after staging lowers the applied leverage.
- Missing source leverage becomes `1x`.
- Venue maximum remains authoritative.
- Reduce-only closes are unchanged.
- Manual `orders.submitPerp` tests remain unchanged and passing.

### Web

- Global control loads, validates, saves, and refreshes follows.
- Per-follow control inherits, saves a lower value, clears to null, and blocks a
  value above global.
- Arming summary shows the effective ceiling.
- Desktop and narrow/mobile renderings keep controls reachable and labeled.
- Manual trade ticket leverage tests remain unchanged.

### Local live proof

After the feature tests pass and the local migration is applied:

1. Set the funded local test user’s global copy maximum to `2x` through the
   user-facing API/UI.
2. Leave the four existing follows’ per-follow cap null so they inherit `2x`,
   unless a lower follow-specific test is deliberately chosen.
3. Restart the local API/worker with the funded proof account deliberately
   configured for a `$10.55` maximum order notional and one order per day.
   These were proof-account settings, not production constants; the environment
   leverage variable is no longer authoritative.
4. Use the embedded browser to confirm the rendered global and per-follow
   values.
5. Continue monitoring only genuinely new followed-leader signals.
6. On the first eligible entry, reconcile the candidate, delivery, order row,
   and official Hyperliquid fill. Prove effective leverage is at most `2x`,
   actual notional respects that proof account's configured `$10.55` ceiling,
   and its configured one-order daily limit prevents a second mirror order that
   UTC day.

No production deployment is part of this work. A pull request is prepared only
after local tests and the live mainnet proof succeed.

## Out of Scope

- Changing manual-trade leverage UX or semantics.
- A platform/operator-selected product leverage cap.
- Using a per-follow value to raise the global maximum.
- Per-symbol user leverage policies.
- Portfolio liquidation, automatic position closure when a cap is lowered, or
  retroactive changes to already-filled positions.
- Deploying to production.
