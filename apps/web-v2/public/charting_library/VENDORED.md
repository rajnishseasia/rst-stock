# TradingView Advanced Charts (vendored)

This directory contains a vendored copy of the **TradingView Advanced Charts**
library (a.k.a. "Charting Library"), v31.2.0. It is loaded at runtime by
`src/components/charts/advanced-chart.tsx` via:

```html
<script src="/charting_library/charting_library.standalone.js"></script>
```

## Source

Pulled from the private GitHub repo `tradingview/charting_library` (access
granted via TradingView's licensing application). Drop a new release in place
by replacing the contents of this directory with the new release's
`charting_library/` folder.

## License

Use of this code is governed by the TradingView Advanced Charts End User
License Agreement that the account holder accepted when applying. Do **not**
copy this directory into a public repository.

## What we don't ship

The official package also includes a reference `datafeeds/udf/` folder with a
TypeScript-based UDF datafeed implementation. We do not use it — `tv-datafeed.ts`
implements a custom datafeed against our existing Alpaca-backed tRPC
endpoints — so the `datafeeds/` folder is intentionally absent.

## Types

The matching TypeScript declarations live at
`apps/web-v2/src/vendor/charting_library/charting_library.d.ts` plus a small
`index.d.ts` that re-exports the bits we use and declares `window.TradingView`
globally. Update both the runtime bundle and the `.d.ts` whenever you upgrade.
