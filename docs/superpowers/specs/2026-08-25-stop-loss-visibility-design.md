# Stop-Loss Visibility: Chart Lines, Perp Closed Positions, External Stop Alerts

Date: 2026-08-25
Status: Design, pending implementation

## Problem

Three related gaps, all of them variations of "the app does not tell you
what your stop did".

1. An open position's stop-loss is invisible on the chart. The price is in
   the database but never drawn, so there is no visual read on how much room
   a trade has.
2. The perps terminal has no closed-positions view. `PerpBottomPanel` shows
   Positions and a raw fills list; there is no round-trip record of a trade
   that is already over, on desktop or mobile.
3. A stop-loss that fires at the broker raises no alert. This is the one
   that actually cost something: a Hyperliquid stop hit and the only way to
   find out was to open the venue's own UI.

## Current State (verified against the tree at 158c6a54)

### Chart

`apps/web-v2/src/components/charts/advanced-chart.tsx` (505 lines) owns a
`IChartingLibraryWidget` in `widgetRef` and re-uses it across symbol and
theme changes rather than rebuilding. It calls no shape or line API today.
The vendored charting library (`apps/web-v2/src/vendor/charting_library`)
exposes `createPositionLine()`, `createOrderLine()` and
`createMultipointShape()`, so horizontal lines are additive: no widget
rebuild, no datafeed change.

Existing precedent for chart annotations is `perp-chart-annotations.ts`,
which maps HL fills into `ApiExecutionGroup` bubbles. Stop lines are a
different mechanism (price-anchored, not time-anchored) and get their own
module.

### Stop-loss data already persisted

| Case | Where the stop price lives |
| --- | --- |
| Equity bracket / OTO entry | `orders.stopMarketPrice`, and `orders.exitPlan.stopPrice` (`OrderExitPlan`) |
| Perp in-app TP/SL | Its own `orders` row, reduce-only, `clientOrderId` `<seed>:sl:<px>` (see `pendingTpSlOrderRows` in `apps/api/src/routers/orders.ts`) |
| Copy-mirrored perp | `orders.perpProtection.stopLossPx` (`PerpProtectionPlan`), with `perpProtectionStatus` saying whether the leg is actually live |

Note that `smart_exit_legs` has leg types `take_profit` and `trailing_stop`
only. There is no stop leg row for equities: the stop is a child of the
broker order.

### Perps panels

- `apps/web-v2/src/components/perps/perp-bottom-panel.tsx` (104 lines):
  two tabs, `positions` and `history`.
- `apps/web-v2/src/components/perps/perp-fills-panel.tsx` (188 lines):
  fill-level rows from `trpc.positions.listPerpFills`, 30s poll, limit 100.
- `positions.listPerpFills` (`apps/api/src/routers/positions.ts:1487`)
  calls `info.listFills(walletAddress, limit)` and cross-references fill
  `oid` against `orders.brokerOrderId` to label SL/TP fills. Each fill
  carries HL's `dir` ("Open Long", "Close Long", ...) and `closedPnl`.
- Desktop mounts through `terminal-chart-panel.tsx`; mobile mounts through
  `venue-aware-panels.tsx`. Both must be touched for a new tab.

### Alert paths

- `OrderSyncPoller` (`apps/worker/src/services/order-sync.ts`) is
  row-driven. It iterates RST-owned `orders` and asks Alpaca about each.
- `HyperliquidOrderSyncPoller`
  (`apps/worker/src/services/hyperliquid-order-sync.ts`) is also row-driven,
  scanning `venue = "hyperliquid"` rows in PENDING / SUBMITTED / PARTIAL,
  and notifies on completed fills.
- `ExternalFillPoller` (`apps/worker/src/services/external-fill-sync.ts`) is
  the inverse for Alpaca: it LISTs broker orders and ingests ones with no
  matching row. Its own header names on-site stop-losses as the motivating
  case. It is gated on `EXTERNAL_FILL_DETECT_ENABLED === "true"` and ships
  inert (`external-fill-sync.ts:621`).
- `sendDiscordNotification` (`apps/worker/src/services/discord-notify.ts`)
  is the single webhook sink, gated on `DISCORD_WEBHOOK_URL`.

### Diagnosis of the missed stop

Two distinct holes, and the venue decides which one bit.

**Alpaca.** A bracket or OTO stop is a broker-side child order. It gets no
`orders` row of its own, only `stopMarketPrice` recorded on the parent.
Because `OrderSyncPoller` is row-driven, the stop's fill is structurally
invisible: no webhook fires, and the entry row stays `FILLED` forever while
the position is actually flat. `ExternalFillPoller` is the intended fix and
it is switched off.

**Hyperliquid.** A stop placed inside the app does get a row and does
notify. A stop placed directly in the Hyperliquid UI does not, and there is
no HL counterpart to `ExternalFillPoller`, so nothing in the system was ever
going to see it. This is the likely cause of the reported miss.

## Scope Decisions

Confirmed with the repo owner on 2026-08-25:

- **Alert scope:** both venues, Hyperliquid first.
- **Closed positions:** derived from HL fills, no new table.
- **Chart lines:** in-app stops only, drawn from the database. No new
  broker open-orders reads for the chart.

## Design

### Piece 1: Stop-loss lines on the chart

**New pure module** `apps/web-v2/src/components/charts/stop-loss-lines.ts`.

```
export interface StopLossLine {
  id: string;          // stable across polls, drives diffing
  price: number;
  label: string;       // e.g. "SL 60,000.13" or "SL (unprotected)"
  tone: "active" | "pending" | "unprotected";
}

export function stopLossLinesForSymbol(
  input: StopLossSource,
  chartSymbol: string,
): StopLossLine[]
```

Pure, no React, no widget. Unit-tested directly, in the shape of
`perp-chart-annotations.ts`.

Rules it encodes:

- Equity: an entry order that is `FILLED`, position still open, with a
  `stopMarketPrice` or `exitPlan.stopPrice`. Prefer `exitPlan.stopPrice`
  when both are present, since that is the resolved plan.
- Perp: prefer a live reduce-only SL `orders` row for the coin (tone
  `active`). Fall back to `perpProtection.stopLossPx`, with tone driven by
  `perpProtectionStatus`: `attached` renders `active`, `unprotected`
  renders `unprotected`, `cancelled` renders nothing.
- Symbol matching uses the existing canonical-coin helper
  (`perpDisplayCoin`) for perps and a plain uppercase compare for equities.
- More than one stop for the same symbol is possible (scaled entries).
  Return one line per distinct price, deduped, capped at 5 so a pathological
  account cannot paint the pane solid.

**New API surface.** One procedure, `positions.listStopLossLevels`,
returning `{ symbol, price, kind, status }[]` for the caller's open
positions. It reads the `orders` table only, with an explicit `.limit()`
against a named constant, per the pagination rule in CLAUDE.md. It does not
call any broker.

**Widget wiring.** A new hook
`apps/web-v2/src/components/charts/use-stop-loss-lines.ts` takes the widget
ref and the lines array, and reconciles them: create a line per new id,
update price on change, remove entities for ids that disappeared. It holds
a `Map<string, IPositionLineAdapter>` in a ref and tears everything down on
unmount and on symbol change. Red comes from
`chart-brand-colors.ts`, extended with a stop tone rather than a hardcoded
hex, so light and dark both work. `unprotected` renders dashed to
distinguish "we intended a stop" from "a stop is resting".

`advanced-chart.tsx` gains only the hook call plus one prop. It is already
at 505 lines, right at the god-component threshold in CLAUDE.md, so all new
logic lands in the two new files and nothing else is added to it.

### Piece 2: Perp closed positions

**New pure module**
`apps/web-v2/src/components/perps/perp-closed-positions.ts`.

```
export interface ClosedPerpPosition {
  coin: string;
  side: "long" | "short";   // the side that was held, not the closing side
  closedAt: number;         // ms, the last closing fill
  openedAt: number | null;  // ms, first opening fill in the run, null if it
                            //     predates the fills window
  sizeCoin: number;         // total size closed
  avgClosePx: number;
  realizedPnl: number;      // sum of HL closedPnl over the closing fills
  feeUsd: number;
  partial: boolean;         // true when the run is truncated by the window
  closedBy: "manual" | "stop_loss" | "take_profit" | "liquidation" | "unknown";
}

export function closedPerpPositions(
  fills: readonly PerpFill[],
): ClosedPerpPosition[]
```

Algorithm: walk fills per coin oldest to newest, maintaining a running
signed size. HL's `dir` field says whether a fill opens or closes. A run
closes when running size returns to zero; emit one `ClosedPerpPosition` for
that run. A run still open at the end of the list is not emitted (it is a
current position and already has a panel). A closing run whose opening fills
fall outside the window is emitted with `openedAt: null` and
`partial: true`, so a truncated history is labelled rather than silently
wrong.

`closedBy` reuses the SL/TP labelling `listPerpFills` already computes from
`orders.orderType`, and reads HL's liquidation marker when present. This is
what makes the panel answer "did my stop fire", which is the whole point.

**API.** `listPerpFills` already returns everything needed. Raise its
default limit for this call site (request 200) rather than adding a
procedure. The `partial` flag exists precisely because that window is
finite; the panel says "showing the last N fills" in its empty and footer
states.

**UI.** `PerpClosedPanel`
(`apps/web-v2/src/components/perps/perp-closed-panel.tsx`), built from the
same table chrome, P&L tokens and `formatPerpPx` / `formatPerpUsd` idiom as
`PerpFillsPanel` so the three tabs read as one system. Columns: closed time,
coin, side, size, avg close, realized PnL, fee, closed-by badge.

**Mounting, both viewports.** `PerpBottomPanel` gains a third tab,
`closed`, between Positions and History. The tab type becomes
`"positions" | "closed" | "history"`. Desktop reaches it through
`terminal-chart-panel.tsx`, mobile through `venue-aware-panels.tsx`, which
route to `PerpPositionsPanel` directly today; both get the closed panel
alongside. Per the responsive-shell rule in CLAUDE.md, the inactive shell is
not rendered, so the query must be gated on the tab being active as well as
on `enabled`, or the hidden viewport will poll.

### Piece 3: External stop-loss detection and alerting

Two independent workstreams. Hyperliquid is new code; Alpaca is enabling
and verifying code that already exists.

#### 3a. Hyperliquid external fill poller (new)

`apps/worker/src/services/hyperliquid-external-fill-sync.ts`, deliberately
modelled on `external-fill-sync.ts` and inheriting its guarantees verbatim:

1. **Kill switch.** `HYPERLIQUID_EXTERNAL_FILL_ENABLED`. Unlike the Alpaca
   one this should default ON in a deployment that already runs
   `HyperliquidOrderSyncPoller`, since it is read-only and its absence is
   the bug being fixed. Ship it off, flip it on after the testnet run.
2. **Read-only.** Keyless `createHyperliquidInfoClient` only, exactly as
   `hyperliquid-order-sync.ts` does. It structurally cannot sign, so it
   cannot place, cancel or withdraw.
3. **Cursor.** Reuse the `external_fill_cursors` table, namespaced by venue,
   so a restart re-reads rather than skips. Seed the cursor at
   `now - HYPERLIQUID_EXTERNAL_FILL_BACKFILL_MS` (default 0) before the
   first read, so enabling it cannot spray months of old fills.
4. **Classification.** For each fill, look up `oid` in
   `orders.brokerOrderId` for that user and venue. A hit is known and is
   left entirely to `HyperliquidOrderSyncPoller`. A miss is external.
5. **Insert-only.** External fills insert a reconciled `orders` row with
   `externalOrigin = true` and a deterministic
   `hlextfill:<digest>` client order id, so the
   `orders_client_order_id_unique` index absorbs overlap. Existing rows are
   never modified.
6. **Notify once.** Notify only when the insert actually created a row, so a
   re-read cannot double-ping. Route through `sendDiscordNotification`.
7. **Owner preference.** Nothing reaches the social feed or copy-mirror
   unless `users.shareTrades` is true, matching
   `apps/api/src/lib/social-publish.ts`.

Pure decision logic (classification, cursor advance, run detection) goes in
`apps/api/src/lib/hyperliquid-external-fill.ts` and is unit-tested with no
DB and no network, matching how `hyperliquid-order-sync.ts` splits.

#### 3b. Make a stop fill legible in the alert

`OrderNotification` and `formatOrderLine` in `discord-notify.ts` currently
describe an order, not why it filled. A stop fill reads identically to a
manual close, which is exactly the confusion being fixed.

Add an optional `closeReason?: "stop_loss" | "take_profit" | "liquidation"`
to `OrderNotification` and render it as a prefix, for example
`STOP HIT | BTC sell 0.5 @ 60,000.13`. Populate it from:

- the reduce-only `:sl:` client-order-id convention for in-app perp stops,
- `perpProtection.legClientOrderIds` for mirrored perp stops,
- the Alpaca child-order relationship for equities (see 3c).

Check `shouldSuppress` while here: the stop-fill path must land in the
`isMarketType` + `FILLED` branch that passes, and a `closeReason` line
should never be suppressed regardless of order type.

#### 3c. Alpaca: enable and verify `ExternalFillPoller`

No new poller. The work is:

1. Set `EXTERNAL_FILL_DETECT_ENABLED = true` in the worker environment
   (`docs/deployment/copy-mirror-env-reference.md:135` already prescribes
   this for a copy-trading deployment).
2. Confirm on a paper account that a bracket stop firing produces exactly
   one ingested row and one webhook, and that re-reads produce zero extra.
3. Map the ingested child order back to its parent so `closeReason` can be
   set. Alpaca returns the child's relationship on the order; if the
   parent link is not available on the LIST response, fall back to matching
   symbol plus the parent's `stopMarketPrice`, and leave `closeReason`
   unset rather than guessing wrong.

Note that enabling this flag also feeds copy-mirror, per the audit note in
`docs/audits/2026-08-alpaca.md:244`. That is a real blast-radius change and
belongs in its own commit with its own testnet or paper verification, not
bundled with the UI work.

## Testing

- `stop-loss-lines.ts`: pure unit tests over each source (equity stop,
  equity exit plan, perp SL row, perp protection in all three statuses,
  dedupe, cap, symbol mismatch).
- `use-stop-loss-lines.ts`: reconciliation against a fake widget adapter,
  asserting create / update / remove and full teardown on unmount.
- `perp-closed-positions.ts`: pure unit tests over scale-in, scale-out,
  flip long to short in one fill, truncated window (`partial`), and each
  `closedBy` classification.
- `perp-closed-panel.tsx`: behavioural render tests. No source-string or
  `readFileSync` tests, per CLAUDE.md; the allowlist shrinks, never grows.
- `hyperliquid-external-fill.ts`: pure classification and cursor tests.
- `hyperliquid-external-fill-sync.ts`: poller tests with a fake info client
  and DB, covering kill switch off, first-scan seeding, known-vs-external
  split, insert conflict absorbing a re-read, notify firing exactly once,
  and per-account failure not advancing the watermark.
- `discord-notify.ts`: `formatOrderLine` with each `closeReason`, and
  `shouldSuppress` never suppressing a close-reason line.

## Sequencing

Three commits on one branch off `main`, per the PR rule in CLAUDE.md. No
stacked PRs.

1. **Perp closed positions.** Self-contained, no worker or schema change,
   ships value immediately.
2. **Chart stop-loss lines.** Adds one read-only procedure plus two new
   frontend modules.
3. **External stop detection.** HL poller plus the `closeReason` alert
   change. The Alpaca flag flip is a separate follow-up commit with its own
   verification, because it also arms copy-mirror ingestion.

## Out of Scope

- Persisting closed positions in the database. Derived from fills for now;
  revisit if leaderboards need permanent round-trip history.
- Drawing broker-side stops that were placed outside the app. The chart
  reads the database only.
- Take-profit lines on the chart. Same mechanism, easy to add later, not
  asked for.
- Editing a stop by dragging its line.
