/**
 * The brand direction colors as the TradingView iframe needs them: literal
 * hex, because widget overrides and datafeed marks are serialized into the
 * chart iframe and cannot read the app's CSS variables.
 *
 * ONE definition on purpose. The candle style (advanced-chart.tsx) and the
 * execution marks (tv-datafeed.ts) each used to hardcode these values with a
 * comment asking the editor to keep the other file in sync by hand; if the
 * brand green/red is ever retuned (warming the loss ramp is an open product
 * question), a manual sync misses one site and candles stop matching the
 * marks drawn on top of them.
 *
 * Values mirror the dark theme's --color-green-400/500 and
 * --color-red-400/500 in globals.css. If those tokens change, change these in
 * the same commit.
 */

/** Dark-theme gain: --color-green-500 with the 400 shade as its border. */
export const CHART_UP_COLOR = "#43d39a";
export const CHART_UP_BORDER = "#1f9d6b";

/** Dark-theme loss: --color-red-500 with the 400 shade as its border. */
export const CHART_DOWN_COLOR = "#ed6a64";
export const CHART_DOWN_BORDER = "#d0543f";

/** Light-theme gain/loss: the light brand ramp's green-500 / red-500. */
export const CHART_LIGHT_UP_COLOR = "#157a52";
export const CHART_LIGHT_DOWN_COLOR = "#c0432f";

/**
 * The six candle-style keys for a theme, shared by widget construction and
 * the changeTheme effect. Both themes are branded so a theme switch never
 * depends on TradingView's own defaults: changeTheme repaints the chart with
 * the library's stock palette, which is exactly how a light-initialized chart
 * ended up with unbranded dark candles until remount.
 */
export function brandCandleOverrides(theme: "light" | "dark") {
  const up = theme === "dark" ? CHART_UP_COLOR : CHART_LIGHT_UP_COLOR;
  const down = theme === "dark" ? CHART_DOWN_COLOR : CHART_LIGHT_DOWN_COLOR;
  return {
    "mainSeriesProperties.candleStyle.upColor": up,
    "mainSeriesProperties.candleStyle.wickUpColor": up,
    "mainSeriesProperties.candleStyle.borderUpColor": up,
    "mainSeriesProperties.candleStyle.downColor": down,
    "mainSeriesProperties.candleStyle.wickDownColor": down,
    "mainSeriesProperties.candleStyle.borderDownColor": down,
  } as const;
}
