# One-Click Exit Plan ("Smart Exit") — Design

Date: 2026-06-19
Status: Approved (Approach A)

## Problem

Placing a risk-managed trade today takes too many hidden steps. The trade form
buries the protective-exit flow:

- The "Stop Loss Price (sizing only)" field looks like a stop but never places a
  broker stop — an amber box has to be expanded to learn this.
- The real auto-exit (OCO) flow is hidden behind a small "+ Add take-profit +
  stop (auto-exit)" link.
- The exit-plan card, once revealed, starts empty and requires manually tapping
  `+0.4R / +0.7R` buttons.
- The "Skip preset TP, use trailing stops" checkbox is a no-op in the UI.

The desired workflow: **click a signal (or just open the form) → review →
Submit.** The trade should arrive pre-sized, with a protective stop and a
take-profit plan where part of the position trails up automatically, so the user
does not have to watch the chart to exit.

## Goals

1. For equity orders, default to an always-visible, pre-filled **Exit plan**.
2. Auto-fill: stop = Low of Day (long) / High of Day (short); Max $ Risk = last
   value used; quantity = sized from risk; take-profits = **0.4R on 50%** of
   shares (fixed limit) + a **real trailing stop on the other 50%** with trail%
   ≈ 1R as a percent of entry.
3. Clicking a signal additionally fills symbol/side/entry, so the only remaining
   action is Submit.
4. Document the behavior in the in-app guide and README.

## Non-goals

- Options: bracket/OCO and this exit plan remain equity-only (Alpaca rejects
  bracket/trailing for options). The exit-plan card is not shown for options.
- Configurable per-user defaults (R multiples, split %). Hard-coded defaults for
  now; revisit later.

## Key constraint

A trailing-stop **sell** can only be placed once the shares are held — Alpaca
rejects it pre-position, and it cannot be a leg of a bracket/OTO order. So the
exit plan must be attached **after the entry fills**.

Existing primitives we reuse:

- `OrderSyncPoller` (`apps/worker/src/services/order-sync.ts`) already polls
  `SUBMITTED`/`PARTIAL` orders every 30s and detects the transition to `FILLED`.
- `AlpacaClient.createExitStrategy()` already places "scale-out TP limit(s) +
  trailing stop" against a held position.

## Approach A — Worker-attached exit plan (chosen)

Submit the entry as a single order for the full quantity, carrying a resolved
exit plan. When the poller observes the entry fill, it attaches the exit plan.

Rejected alternatives:

- **B (inline attach, market-only):** submit + poll + attach in one request. No
  DB/worker change, but resting-limit entries (which signal-copy uses) never get
  a trailing stop, and it blocks the request. Fails the "walk away" goal.
- **C (fixed brackets only):** both TPs as fixed bracket limits, no real
  trailing. Rejected — the user explicitly wants a real trailing runner.

## Architecture

### Data flow

```
TradeForm (equity, exit plan ON)
  → resolve { stop, qty, TP@0.4R (50%), trailing (50%, trail% = 1R/entry) }
  → orders.submitWithExitPlan (entry order, full qty)
      → Alpaca: place entry (market or limit@entry)
      → DB orders row: exitPlan(jsonb) + exitPlanStatus = 'pending'
OrderSyncPoller (every 30s)
  → entry order status → FILLED  AND exitPlanStatus = 'pending'
      → createExitStrategy(filledQty: TP 50% + trailing 50%)
      → exitPlanStatus = 'attached'  (or 'failed' + exitPlanError)
```

### Components and contracts

**Frontend — `apps/web-v2/src/components/trade/trade-form.tsx`**

- Equity default: exit plan visible and ON. Remove the hidden "+ Add
  take-profit + stop (auto-exit)" reveal and the amber "Sizing only" box;
  replace with the always-shown Exit plan card.
- Auto-fill (additive, all fields editable):
  - `entryPriceRef` ← signal entry, else live last/mid.
  - `stopMarketPrice` ← `stockQuote.low` for long, `stockQuote.high` for short.
  - `maxRisk` ← persisted last value from `localStorage` key
    `rst:lastMaxRisk` (default "100"); persisted on submit.
  - `quantity` ← `round(maxRisk / |entry − stop|)`, applied automatically when
    entry+stop+risk are known.
  - Exit plan rows: TP1 = price at 0.4R, qty = `floor(qty/2)`; trailing runner =
    remaining qty, trail% = `round((|entry − stop| / entry) * 100, 2)` clamped to
    a sensible minimum (e.g. 0.1%).
- `skipPresetTp` checkbox: repurpose to "Use a single trailing stop (no 0.4R
  take-profit)" — when checked, the whole position trails and no fixed TP is
  placed. Clear label so it is no longer a no-op.
- New submit path calls `orders.submitWithExitPlan` when the exit plan is active
  (equity + has stop + has at least the trailing runner). Falls back to the
  existing plain submit otherwise.

**Backend — DB (`packages/db/src/schema`)**

Add to `orders`:

- `exitPlan` jsonb nullable — the resolved plan:
  ```ts
  {
    takeProfits: Array<{ price: number; qty: number }>;
    trailingStop?: { trailPercent: number }; // qty derived from filled qty at attach time
  }
  ```
- `exitPlanStatus` text/enum nullable — `'pending' | 'attached' | 'failed'`
  (null/absent = no exit plan).
- `exitPlanError` text nullable — failure detail for surfacing/debugging.

**Backend — API (`apps/api/src/routers/orders.ts`)**

- `submitWithExitPlan` mutation: validates equity-only, side, qty, entry, stop,
  the resolved take-profit/trailing config. Places the entry order (market or
  limit@entry) for the full qty, inserts the `orders` row with `exitPlan` and
  `exitPlanStatus = 'pending'`. Returns the order id.
- Reuse existing helpers (`getAlpacaClient`, friendly errors, social publish).

**Backend — Worker (`apps/worker/src/services/order-sync.ts`)**

- After persisting a status change to `FILLED`, if the order has
  `exitPlanStatus = 'pending'`, call `client.createExitStrategy` with:
  - `symbol`
  - `takeProfits` from `exitPlan.takeProfits` (qty re-derived against the actual
    `filled_qty`: TP = `floor(filledQty * tpFraction)`, trailing = remainder)
  - `trailingStop` = `{ qty: remainder, trailPercent }`
  - Set `exitPlanStatus = 'attached'` on success; on error set `'failed'` and
    store `exitPlanError`. Idempotent: only acts while status is `pending`.
- Only attach on full `FILLED` (not `PARTIAL`) to keep qty math simple.

### Edge cases

- **Long vs short:** stop side = LOD (long) / HOD (short); R distance uses the
  correct sign. Trailing sell only valid for long exits; for short positions the
  trailing leg is a buy-to-cover trailing stop (handled by `createExitStrategy`
  side as appropriate — note: current `createExitStrategy` hard-codes sell; this
  design targets long entries first and treats short trailing as out-of-scope if
  the helper does not support buy-side — see Open question below).
- **Partial fill:** wait for full `FILLED`; do not attach on `PARTIAL`.
- **Odd share count:** TP gets `floor`, trailing runner gets the remainder so the
  full position is covered.
- **Limit entry never fills:** order rests/expires; no exit placed; no harm. If
  the entry is later CANCELLED/EXPIRED, leave `exitPlanStatus = 'pending'`
  untouched (no position to protect) — the poller only attaches on FILLED.
- **Min trail%:** clamp to ≥ 0.1% so Alpaca accepts it.
- **`createExitStrategy` partial failure:** if TP places but trailing fails (or
  vice versa), record `failed` with the error; the user still has whatever legs
  succeeded plus the data to retry manually.

## Defaults (locked)

- Exit plan default: **ON** for equities (every order + signal-click).
- 0.4R take-profit on **50%**, trailing runner on **50%**.
- Trail% = **1R as a percent of entry** (`|entry − stop| / entry * 100`).
- Last Max $ Risk persisted in `localStorage`, default `100`.

## Testing

- `trade-form.test.ts`: risk→qty sizing; 0.4R price math (long & short); LOD/HOD
  stop selection; 50/50 qty split with odd totals; trail% computation and min
  clamp; localStorage last-risk read/write.
- `order-sync` test: FILLED + pending → `createExitStrategy` called with correct
  symbol/TP/trailing and re-derived qty against `filled_qty`; status → attached;
  failure → failed + error; PARTIAL does not attach; non-pending orders ignored.

## Rollout / DB checklist

- [ ] Production schema update: point `DATABASE_URL_DIRECT` at Supabase and run
  `bun run db:push` (review proposed statements) before enabling in prod.
- [ ] Verify `orders.exit_plan`, `orders.exit_plan_status`,
  `orders.exit_plan_error` exist in Supabase.

## Open question (resolve in implementation)

- Short-side trailing: confirm whether `createExitStrategy`/`createTrailingStopOrder`
  accept a buy side. If not, scope the first cut to **long** entries for the
  trailing runner and fall back to a fixed 0.4R/0.75R bracket for shorts, noted
  in the UI. (Longs are the dominant signal case.)
</content>
</invoke>
