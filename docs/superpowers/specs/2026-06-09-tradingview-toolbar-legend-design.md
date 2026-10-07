# TradingView Toolbar and Legend Design

## Goal

Improve the embedded TradingView chart header so the timezone controls remain
readable and the quote summary does not appear beneath them.

## Scope

Update the shared `TradingViewChart` widget configuration only.

- Set the supported `backgroundColor` option to the chart theme's background
  color, providing a solid matching chart surface behind the
  `ET / Local / UTC` controls.
- Set `hide_legend` to `true` so TradingView does not render the price and
  percentage-change data below the controls.

## Non-Goals

- Do not add a local overlay or mask over the embedded chart.
- Do not remove or disable the timezone controls.
- Do not replace TradingView or change its chart data behavior.
- Do not change quote displays outside the embedded TradingView chart.

## Testing

Add a focused configuration test that verifies the widget receives the matching
chart background and hidden-legend options. Run the web typecheck and the
focused test after implementation.
