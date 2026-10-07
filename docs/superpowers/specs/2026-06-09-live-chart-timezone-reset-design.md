# Live Price Chart: Timezone Control + Reset Button

**Date:** 2026-06-09
**Component:** `apps/web-v2/src/components/charts/live-chart.tsx`
**Library:** lightweight-charts v5.2.0

## Goal

On the live price (candlestick) chart, let the user:

1. See which timezone the time axis is displayed in (always visible, default **ET**).
2. Switch the displayed timezone between **ET**, their **Local** zone, and **UTC**.
3. Reset the zoom/pan view back to fit the latest data with one click.

Scope is limited to `live-chart.tsx`. The portfolio history chart and TradingView
widget are out of scope.

## Background

lightweight-charts interprets every timestamp as UTC and has **no built-in
timezone option**. The chart currently renders the time axis silently in UTC
(`timeVisible: true, secondsVisible: false`, lines 158–162). Bar timestamps are
true Unix-seconds epoch values cast to `UTCTimestamp`. The live-candle snapshot
effect (lines 245–251) computes period boundaries with real UTC epoch arithmetic
(`Math.floor(nowSec / periodSec) * periodSec`).

## Design

### Timezone rendering approach

Two options were considered:

- **Offset the data timestamps** by the zone's UTC offset before `setData`.
  Rejected: breaks DST correctness across a multi-day range and corrupts the
  live-candle period math, which depends on true UTC epoch values.
- **Custom formatters (chosen):** keep timestamps as true UTC epoch (no data
  mutation) and format the displayed labels through `Intl.DateTimeFormat` with
  the selected `timeZone`. DST-correct; zero impact on the live-bar logic.

Two formatters are wired via `chart.applyOptions(...)`:

- `timeScale.tickMarkFormatter` → formats the x-axis tick labels in the chosen zone.
- `localization.timeFormatter` → formats the crosshair time label in the chosen zone.

These are applied in a `useEffect` that re-runs when the timezone changes, so the
chart instance is **not** re-created on timezone switches.

Note: lightweight-charts groups/places tick marks by UTC, so tick *placement* day
boundaries are computed in UTC; only the *labels* are localized. This is the
standard documented behavior and is acceptable for this chart.

### Time-formatting helper (tested)

Extract pure formatting logic into a sibling module
`apps/web-v2/src/components/charts/chart-time.ts`:

```ts
export type TzChoice = "market" | "local" | "utc";

export function resolveTimeZone(choice: TzChoice): string; // IANA id
export function tzLabel(choice: TzChoice): string;          // "ET" | "Local" | "UTC"

// timeSec is Unix seconds (UTCTimestamp value).
export function formatChartTick(timeSec: number, tzId: string): string;
export function formatChartCrosshair(timeSec: number, tzId: string): string;
```

- `market` → `America/New_York` (label **ET**)
- `local` → `Intl.DateTimeFormat().resolvedOptions().timeZone` (label **Local**)
- `utc` → `UTC` (label **UTC**)

`formatChartTick` shows time-of-day for intraday and month/day for the daily
timeframe; `formatChartCrosshair` includes the date plus time. Both use
`Intl.DateTimeFormat` with the resolved `timeZone`.

### State & persistence

```ts
const [tz, setTz] = useState<TzChoice>(/* read localStorage, fallback "market" */);
```

- Initialize from `localStorage["liveChart.timezone"]`, validated against the three
  allowed values, falling back to `"market"`.
- On change, write the new value back to `localStorage`.
- Guard all storage access (SSR / disabled storage) in a `try/catch`; never throw.

### UI

Add a control cluster at `absolute right-2 top-2 z-30`, mirroring the existing
timeframe button styling (`rounded px-2 py-0.5 text-[11px]`, active =
`bg-primary text-primary-foreground`, inactive = `text-muted-foreground hover:bg-muted/60`):

- Three toggle buttons: **ET / Local / UTC**. The active one is highlighted, so the
  current timezone is always visible without a click.
- A reset icon-button (`RotateCcw` from `lucide-react`) beside the toggles, with an
  accessible `aria-label="Reset chart view"` / `title`.

The existing live-price badge (currently `absolute right-16 top-2`, lines 312–327)
is moved to a second row at `right-2 top-9` so it does not collide with the new
top-right controls. The timeframe selector stays at `left-2 top-2`.

### Reset behavior

```ts
function resetView() {
  const ts = chartRef.current?.timeScale();
  ts?.fitContent();
  ts?.scrollToRealTime();
}
```

Resets only the zoom/pan view. Timeframe and timezone selections are left unchanged.

## Testing

- **Unit tests** for `chart-time.ts`: `formatChartTick` / `formatChartCrosshair`
  produce correct strings for the same instant in ET vs UTC, and a date inside US
  daylight-saving time (e.g. July) vs standard time (e.g. January) to confirm DST
  is handled by `Intl.DateTimeFormat`. `resolveTimeZone` / `tzLabel` map correctly.
- **Manual verification** by running the app: toggle ET/Local/UTC and confirm axis +
  crosshair labels shift; zoom/pan then click reset and confirm the view snaps back;
  reload the page and confirm the timezone choice persisted.

## Out of scope

- Portfolio history chart and TradingView widget timezone handling.
- A full IANA timezone picker (only ET / Local / UTC).
- Resetting timeframe or timezone via the reset button.
