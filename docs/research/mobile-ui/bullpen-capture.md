# Bullpen mobile UI capture (app.bullpen.fi)

Captured at a 375x812 mobile viewport, signed out and then signed in.
Read-only review: no orders placed, no funds moved.

Context for reading this: Bullpen is a **pure crypto venue** (perps, predictions,
spot, onchain). Ready Set Trade is **signal-first across perps AND stocks**, and
the aggregated social signal feed is the product, not a side panel. So the value
here is in Bullpen's *mechanics*, not their information architecture wholesale:
chart-first is the correct default for a venue and the wrong default for a
signal product.

## Screen inventory

### 1. Trade (the landing screen)

Top bar (signed out): hamburger, wordmark, "Sign In".
Top bar (signed in): hamburger, wordmark, **+** (deposit), **arrows** (transfer),
avatar. The primary money action is one tap from every screen.

Symbol header: asset icon, `BTC-USDC`, leverage badge (`40x`), chart-type
toggle, bookmark, share.

Price block: very large price (`$63,048`), signed 24h change under it, and a
right-hand stat stack: `Vol $1.15B`, `OI $2.12B`, `Funding 0.0013%`.

Chart: timeframe pills `1m 5m 1h 4h D 15m` plus a dropdown and `Settings`; an
OHLC row (`O H L C` + change); candles with volume histogram; right-hand price
scale; high/low tags; a live price tag pinned to the scale; TradingView
attribution; fullscreen and settings affordances.

Below the chart: an `Info` disclosure row, then `Order Book` / `Trades` tabs,
then a persistent **Long / Short** pair (green/red, full width).

Bottom tab bar (5): `Trade`, `Predict`, `Wallet`, `$ANSEM`, `Search`.
Signed in, the Wallet tab label is replaced by the **live balance** (`$0.00`).

### 2. Search (full-screen overlay)

Not a dropdown: a full-screen surface with its own input and close control.
Category tabs: `All`, `Perps`, `Predictions`, `Spot`, `Onchain`, `Wallets`.
Results are grouped by asset class, each group with a `See all` link.

Row anatomy varies by class:
- Perps: icon, `BTC-USDC`, leverage badge, `Vol $1.15B`, price, % change.
- Predictions: thumbnail, question, resolution date, cents price, `Yes`/`No`.
- Spot: icon, `HYPE/USDC`, venue glyph, volume, price, % change.

Every row carries live price and volume, so search doubles as market discovery.

### 3. Symbol selection (the key flow)

Tapping `ETH-USDC` in search navigates to the **ETH chart**, not an order form.
The chart header, price block and stats all re-key to ETH; the selected
timeframe (15m) persists across the symbol change. Order entry remains the
persistent bottom CTA.

### 4. Order ticket (bottom sheet)

Opened by tapping `Long`. Presented as a sheet with the chart still visible
above it, so price context is never lost.

- Row of compact pills: `20x` (leverage), `Cross` (margin mode), `Market` (order
  type, dropdown).
- `Long` / `Short` segmented toggle, colored.
- `Available 0.00 USDC` with an inline **+** to add funds.
- `Current Position 0 ETH`.
- Size input with a `USDC` unit switcher (notional vs coin).
- Percentage slider plus a numeric `%` field.
- `Reduce Only` checkbox.
- `TP / SL` checkbox: advanced exit config stays collapsed until wanted.
- Primary CTA is **state-aware**: with a zero balance it reads
  **"Deposit to Trade"**, with `$10 minimum to trade` underneath, rather than a
  disabled "Buy" button.
- `Order Summary` expandable row.

### 5. Predict

Category chips (`Trending`, `Breaking`, `Whales`, `Sports`, `Esports`), a filter
control, a sort dropdown, and topic chips (`All`, `Trump`, `Fed`, ...).
Market cards show the question, two or more outcome rows each with a payout
multiple (`1.71x`) and a probability chip (`59%`), plus
`Vol 10.7M / 5 Markets` and a bookmark.

### 6. Wallet

Gated behind sign-in while charts, search and markets stay fully browsable.
Gating is applied at the account surface, not at the front door.

### 7. Full navigation (hamburger)

`Trade`, `Predict`, `Portfolio`, `Tracker`, `Compete`, `Join $ANSEM`, then
`Markets`, `Live`, `Spot`, `Onchain`, `Rewards`, `Leaderboard`, `Affiliate`,
`Points`.

Note that Bullpen does carry social surfaces (`Tracker`, `Live`, `Leaderboard`,
`Compete`, `Points`), but they sit *below* trading in the hierarchy. Ours is the
inverse by design.

## Patterns worth taking

1. **A symbol tap lands on price, not on a form.** The chart is the answer to
   "what is this?", and the order ticket is one deliberate tap further.
2. **Persistent, color-coded direction CTAs** pinned at the bottom, so intent is
   always one tap away without occupying the screen.
3. **The order ticket is a sheet, not a screen.** Chart context survives.
4. **The CTA names the blocking state** ("Deposit to Trade" + the minimum)
   instead of presenting a disabled control the user has to diagnose.
5. **Progressive disclosure** for TP/SL, Order Summary, Info, Order Book.
6. **Search is a browse surface**, grouped by asset class, with live prices.
7. **Money actions are globally reachable** (+ and transfer in the top bar).
8. **The wallet balance is the nav label**, so funding state is ambient.
9. **Timeframe persists across symbol changes**, treating it as a user
   preference rather than per-symbol state.

## Patterns NOT to take

1. **Chart-first as the app's landing screen.** Correct for a venue; wrong for
   us, where the signal feed is the reason the user opened the app.
2. **Burying social under trading.** Their `Tracker` / `Leaderboard` placement
   is the opposite of our thesis.
3. **A crypto-only symbol grammar** (`BASE-QUOTE`, always-on leverage badges)
   does not fit equities and would misrepresent a stock ticket.

## Second pass: surfaces missed on the first sweep

### 8. Trade screen below the fold

The trade screen keeps going under the chart:
`Info` disclosure, `Order Book` / `Trades`, then a horizontally scrollable tab
strip: `Positions`, `Balances`, `Open Orders`, `Pairs`, `TWAP`, `Trade History`.

Two details matter more than the inventory:
- **`Long` / `Short` stay pinned to the bottom while the content scrolls.** The
  trade intent is never scrolled away from.
- The empty state names the next action: "No Open Positions / Deposit to place
  your first trade" with a `Deposit` button, rather than an empty table.

**The chart traps vertical scroll.** Dragging on the chart zooms it instead of
scrolling the page, so reaching the tabs requires starting the gesture outside
the chart. Worth avoiding in our own implementation.

### 9. Info sheet

A bottom sheet, chart still visible: asset row with live price, then
`24h Change`, `Oracle`, `24h Volume`, `Open Interest`, `Funding`, and a
**funding `Countdown`** (`00:51:41`), plus `Show More`.

### 10. Portfolio / Wallet

`Total Portfolio Value` with absolute and percent change, a four-up action row
(`Deposit`, `Withdraw`, `Transfer`, `More`), then `Cash` broken out by token
with purpose badges (`USDC / Onchain Balance`, `USDC.e / Predictions Balance`),
then per-venue drill-down rows (`Predictions`, `Perps`, `Spot`, `Onchain`), each
with its own value and chevron to `/wallet/{venue}`.

This maps cleanly onto our own split: we have Alpaca (stocks and options) and
Hyperliquid (perps), which is exactly the same "one portfolio, several venues"
problem.

### 11. Tracker (their social layer)

Tabs `Tracking` / `Copying` / `Watchlist`, a wallet filter, plus `Tracker Feed`
and `Alerts`. Empty state is an icon, a headline, one explanatory line, an
inline `Add Wallet` button, AND a persistent bottom `Add Wallet` CTA.

Their social graph is **wallet-based**: what an address is actually holding and
doing. Ours is **content-based**: what a person publicly said and why. Those are
complementary, and ours carries the thesis their version cannot.

### 12. Leaderboard (the most strategically relevant screen)

`Global Leaderboard`, a prominent **"Connect your X Account, compete against the
best of CT"** banner, user search, a metric dropdown (`PNL`) and a window
dropdown (`7 Days`).

Top three render as podium cards (rank, avatar, handle, PNL, venue badges).
Below, a ranked list where each row carries avatar, handle, an X badge, follower
count, PNL, and an inline `Follow` button. **The signed-in user's own row is
pinned and highlighted ("YOU") even at rank 0 with $0.00**, so standing is always
visible.

This is our thesis approached from the opposite end: they attach social identity
to verified PNL; we attach trade ideas to social identity. The pinned-self row,
the metric/window selectors and inline follow are all directly adoptable.

### 13. Competitions

Prize-pool framing (`up to $100,000`), `PNL-Based` and `Ended` status chips,
participation counts, and a minimum. A retention and acquisition layer sitting on
top of the same PNL data as the leaderboard.

## Consolidated: what to take, restated

Mechanics worth adopting, in rough order of value to us:

1. A symbol tap lands on **price and context**, not on an order form.
2. **Pinned direction CTAs** that survive scrolling.
3. The **order ticket as a sheet** over the chart, never a separate screen.
4. **State-aware primary buttons** ("Deposit to Trade", "$10 minimum") and
   **empty states that name the next action**.
5. **Progressive disclosure** for TP/SL, order summary, info, order book.
6. **Search as a grouped browse surface** with live prices per row.
7. **Portfolio broken out per venue** with drill-downs.
8. **Pinned "YOU" row** plus metric and window selectors on the leaderboard.
9. **Balance as ambient state** in the nav, and money actions globally reachable.

Anti-patterns to avoid:

1. Chart-first as the app's landing screen (wrong for a signal-first product).
2. Social surfaces buried beneath trading.
3. Crypto-only symbol grammar that would misrepresent an equity ticket.
4. A chart that swallows page scroll.
