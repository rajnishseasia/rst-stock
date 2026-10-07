# Mobile UI optimization plan

Companion to `docs/research/mobile-ui/bullpen-capture.md`. Written after a
line-level read of the mobile shell (`apps/web-v2/src/app/app/page.tsx`), the
signal feed, both trade tickets, the discovery surfaces and the social panels.
Every file:line below was opened and checked on branch
`research/mobile-ui-bullpen-comparison`.

The thesis does not move: Ready Set Trade is signal-first, across Alpaca
equities/options **and** Hyperliquid perps. Bullpen is a crypto-only venue, so
their chart-first landing is correct for them and wrong for us. Nothing in this
plan changes the mobile landing surface. `mobileScreen` stays `"markets"` and
`mobileFeedTab` stays `"signals"` (`page.tsx:369-370`) throughout.

---

## 1. Honest assessment

### Where Bullpen genuinely beats us on mobile

**A symbol tap lands on price.** Their whole app obeys one rule: tapping a
symbol answers "what is this?" with a chart, and the order ticket is one
deliberate tap further (capture `:102`, `:197`). We have no consistent rule.
Our flagship signal feed has no chart affordance at all (§2 below), and our
watchlist hides the chart action behind an invisible full-bleed button
(`watchlist-panel.tsx:474-482`) while "Trade" gets the only visible control
(`:582-593`).

**The order ticket is a sheet, not a screen.** Their ticket floats over a still
visible chart (capture `:60-61`). Ours is `fixed inset-0 z-[60] bg-background`
(`page.tsx:2119`), an opaque full-screen takeover. That forces us to re-add a
symbol/price header (`:2121-2141`), a "Change symbol" button (`:2143-2156`) and
a body-scroll lock (`:464-478`), and on perps it stacks that header directly on
top of `PerpTradeForm`'s own header (`perp-trade-form.tsx:781-797`), so the same
symbol and mark price render twice.

**The CTA names the blocking state.** "Deposit to Trade" with "$10 minimum"
underneath (capture `:72-75`) instead of a disabled button the user has to
diagnose. We know the blockers, `getSubmitBlocker` (`trade-form.tsx:900-918`)
enumerates sign-in, missing credentials and unselected account, but it only
fires **after** the user taps submit (`:928-929`). The button label never
carries the credential or account state (`:3392-3403`), and instead a ~48-line
red credential card (`:2193-2240`) pushes the ticket below the fold.

**Search doubles as market discovery.** Every Bullpen search row carries live
price, volume and change (capture `:44-49`). Our mobile search is the desktop
typeahead reused verbatim: an `absolute ... max-h-80` dropdown
(`terminal-market-search.tsx:279`) over inert text rows. `markets.search`
returns `{ symbol, name, venues }` and nothing else
(`apps/api/src/lib/markets/market-search.ts:34-41`), and perp coins come back
with `name: ""` (`:225`), so a perp row on a phone is a bare ticker plus a 10px
amber chip.

**Balance is ambient and money actions are global.** Their nav label *is* the
live balance (capture `:36`, `:112`). Our mobile nav entry for that screen reads
"Info" (`page.tsx:3068`), and the header metrics that carry Portfolio, Buying
Power and Perps Balance (`page.tsx:2287-2314`) are styled only inside
`@media (min-width: 1280px)` (`globals.css:348`, rules `:384-407`), so below xl
they render as unstyled text crowded against the hamburger. No money action is
reachable from the mobile shell at all: funding means leaving for `/settings`
or `/guide`.

**Empty states name the next action.** "No Open Positions / Deposit to place
your first trade" with a button (capture `:136-137`). Ours are dead ends:
`"No open positions"` (`positions-panel.tsx:499`), `"No open perp positions."`
(`perp-positions-panel.tsx:357`), and worst of all
`"Set your trading credentials in Settings to see open positions."`
(`positions-panel.tsx:490`), which is actively misleading for a perps-only user.

**Portfolio broken out per venue.** Total value, then a drill-down row per venue
with its own value and chevron (capture `:149-155`). That maps exactly onto our
Alpaca/Hyperliquid split, and we have nothing like it on mobile.

**Pinned self row on the leaderboard.** Their signed-in user's row is pinned and
highlighted even at rank 0 (capture `:179-181`).

### Where we are already better, or structurally advantaged

**Our order tickets are more capable, and in several places ahead of theirs.**
Order-type progressive disclosure with an Advanced expansion for trigger types
(`perp-trade-form.tsx:907-1023`) versus their flat dropdown. Size entered as
*both* coin and USD, simultaneously editable and mark-synced
(`:828-870`), instead of a unit toggle with hidden state. A sticky order-summary
footer that survives body scroll (`:1331-1349`) instead of a collapsed
expander. TP/SL gated off by default (`:1199-1327`, `tpSlEnabled` false at
`:271`) and Reduce Only (`:1176-1183`) are already there. Equities get a review
gate on every mobile submit (`shouldReviewOrder` includes `embedded`,
`trade-form.tsx:920-926`; `embedded` is always passed at `page.tsx:2725`).

**We already have the pinned direction CTA.** `page.tsx:1976-1986` pins a
`Trade {SYMBOL}` button on the mobile chart screen, and it is already
state-aware on the equity branch ("Connect Broker to Trade", `:1984`).

**We already have their leaderboard selectors.** Metric/window/horizon dropdowns
(`leaderboard-view.tsx:239-266`, `:103-116`) and inline Follow wired to the same
follow set the feed uses (`leaderboard-row-cells.tsx:172`,
`follow-button.tsx:28-111`).

**The structural advantage: our social layer carries a thesis.** Bullpen's
tracker and leaderboard are wallet-based. They can tell you what an address
holds and what it earned. They cannot tell you *why*, because a wallet never
states a reason. Ours is content-based: a named person published a call, with
text, at a timestamp, and we measure forward returns on it
(`leaderboard.ts:164`, `:669`). Every mechanic they have on identity, we can run
on a richer object. That is the axis to compete on, not chart chrome.

**And the honest counterweight:** they have exactly one asset class, so every
row can carry a leverage badge and a `BASE-QUOTE` name. We carry equities,
options and perps in one shell, which is why our venue plumbing
(`routeIfCrypto`, `resolveRoute`, `equityOrderSignalId`) exists and why several
of their patterns cannot be lifted without a venue argument. That cost is real
and shows up throughout §2 and §3.

---

## 2. Fix now: small, high value

### F1. A symbol tap must land on the chart (the reported complaint)

**Root cause, verified, and it is three overlapping problems.**

1. **The signal feed has no chart affordance at all.** `SignalFeedProps` declares
   `onViewSymbol: (symbol: string) => void` as required
   (`signal-feed.tsx:458`), and the component immediately discards it:
   `onViewSymbol: _onViewSymbol` (`:486`). `_onViewSymbol` appears nowhere else
   in the file. Both mobile mounts dutifully pass a working handler into that
   void: `onViewSymbol={openMobileChart}` at `page.tsx:1684` (Signals tab) and
   `:1956` (chart-screen news tab). This is the flagship surface of a
   signal-first product, and it is the **only** feed panel in the app without a
   chart action. Every sibling has one: `signa-signals-panel.tsx:131`,
   `best-pick-row.tsx:169`, `social-feed-panel.tsx:208`, `:273`,
   `copy-trade-panel.tsx:833`, `watchlist-panel.tsx:479`.

2. **The only tap target on a ticker is labeled as a trade-form prefill.** The
   card body carries no symbol handler (`signal-feed.tsx:1013-1020`). The single
   control is a `Copy $SYM` chip with `aria-label={`Copy ${t.symbol} to the trade
   form`}` and `title={`Prefill the trade form with $${t.symbol}`}`
   (`:1101-1102`), and its perp twin says "Prefill the perp trade form with
   {coin}" (`:350-355`).

3. **Behavior then diverges by venue, and the perp branch is the literal
   complaint.**

   | chip | handler | mobile result |
   |---|---|---|
   | equity `Copy $NVDA` (`signal-feed.tsx:1091-1099`) | `handleSelectSignal` (`page.tsx:859`) | `focusChartOnNarrowViewport()` (`:566-571`) lands on the **chart** |
   | perp `Copy $HYPE` (`signal-feed.tsx:344-359`) | `handleCopyPerpSignal` (`page.tsx:1014`) | `openTradeSheetOnNarrowViewport()` (`:573-580`) opens the **full-screen ticket** |

   And when the venue is perps, `perpsOnly={venue === "perps"}`
   (`page.tsx:2624`) filters tickers as well as groups
   (`signal-feed.tsx:681-689`), so **every** chip on the landing screen becomes a
   perp chip and every symbol tap opens the ticket.

   **Honesty note on reproduction:** on the stocks venue with an equity signal,
   the chip does chart today. If the user is reproducing there, what they are
   hitting is the label promising a trade form plus the watchlist row, where the
   chart action is an invisible `absolute inset-0` button
   (`watchlist-panel.tsx:474-482`) and "Trade" is the only visible control
   (`:582-593`). Either way the fix is the same: give tickers a real, labeled
   chart affordance.

**What changes.** Adopt the rule four other panels already follow: **a tap on a
ticker or a price is identity and goes to the chart; a tap on a control labeled
Copy or Trade is intent and goes to the prefilled ticket.**

- Widen `onViewSymbol` to `(symbol: string, venue?: MarketVenue) => void`
  (`signal-feed.tsx:458`), matching `watchlist-panel.tsx:28` and what
  `openMobileChart` already accepts (`page.tsx:693`). Propagation through
  `VenueAwareSignalFeed` is automatic, it spreads
  `ComponentProps<typeof SignalFeed>` (`page.tsx:2618`). Stop discarding it at
  `:486`.
- Split each ticker chip into a two-part segmented control inside one bordered
  badge: `$AAPL 189.42 +1.2%` on the left routing to `onViewSymbol`, a compact
  `Copy` on the right keeping the existing handler. Both halves at least 44px
  tall, matching the `min-h-11` the rest of the mobile shell uses
  (`signal-feed.tsx:1084`, `page.tsx:1667`, `:2023`). The `$SYM` text, not the
  price pill, must carry the chart action: `showPricePills` guards the pill
  (`:1106`).
- Do the same to the perp chip. This is not a rewire, there is currently **no
  coin-name element** outside the Copy button (`:355`), and the price span is
  conditional on `markPx` (`:402-413`), so a new element is required. Doing it
  as one segmented chip also collapses the five-badge perp cluster
  (`:364-423`), which fixes F2 below for free.
- **Pass the venue for perps.** `onViewSymbol(coin, "perps")`, never
  `onViewSymbol(coin)`. Without it, `routeIfCrypto` calls `resolveRoute` with no
  venue (`page.tsx:650`), which defaults to stocks
  (`use-symbol-venue-router.ts:70`) and sends a dual-listed ticker to equities
  (`venue-routing.ts:52-54`). A perp `SOL` would chart ReneSola and `APT` would
  chart Alpha Pro Tech, the exact collision documented at
  `signal-feed.tsx:461-470`.
- **Preserve signal provenance on the chart route.** `handleSelectSignal` sets
  `setSelectedSignal(signal)` (`page.tsx:863`); `openMobileChart` (`:693-704`)
  does not. `page.tsx:2722` feeds
  `signalId={equityOrderSignalId(selectedSignal, activeSymbol)}` into the trade
  rail, and that id drives "mark signal TRADED" plus social and leaderboard
  credit (`signal-perp.ts:124-135`). If the chart tap becomes the primary route
  to the ticket without setting `selectedSignal`, every order placed that way
  silently loses its signal link. The chart-nav path from a signal must set
  `selectedSignal`, venue-tagged.

**Files:** `apps/web-v2/src/components/feed/signal-feed.tsx`,
`apps/web-v2/src/app/app/page.tsx` (venue-aware chart nav that also sets
`selectedSignal`), `apps/web-v2/src/components/feed/ticker-chart-action.ts`
(reuse `feedChartViewLabel`, `:17-19`),
`apps/web-v2/src/components/watchlist/watchlist-panel.tsx` (give the chart
action a visible affordance).

**Size:** M. **Risk:** medium. It does not touch order submission, but it edits
the state that prefills live tickets and the state that stamps `signalId` on a
real order. The copy payload must be preserved byte for byte; only the
navigation target changes. Re-run the prefill and trade-form suites.

### F2. Perp chip cluster cannot wrap and can side-scroll the feed

The `PerpCopyChip` wrapper is `flex shrink-0 items-center gap-1.5` with **no**
`flex-wrap` (`signal-feed.tsx:364-369`), inside a parent that does wrap
(`:1014-1018`). Every child is `shrink-0`: Copy badge (`:328-361`), "Hyperliquid
Perp" badge (`:380-389`), direction/leverage badge (`:390-401`), mark + change
(`:402-413`), "Trade stock" (`:414-423`). Nothing compresses and nothing wraps.
The scroll container is `overflow-y-auto` (`:915`), so `overflow-x` computes to
`auto`, and `.no-scrollbar` (`globals.css:33,38`) hides the resulting bar.
"Trade stock" is also `text-[10px]` with no `min-h` and no `embedded` branch,
the only action in the file that never got the mobile treatment (compare `:189`,
`:335`, `:838`, `:853`, `:1084`).

**What changes.** Ships as part of F1's segmented chip: one chip carrying
direction, leverage, price and change; demote "Hyperliquid Perp" to a venue
glyph; add `flex-wrap` and drop `shrink-0` on the wrapper; move "Trade stock"
somewhere it can have a 44px target.
**Files:** `signal-feed.tsx`. **Size:** S (folded into F1). **Risk:** low.

### F3. Perp prices formatted with the fixed 2-decimal helper, including on the review dialog

`CLAUDE.md` mandates `formatPerpPx`/`formatPerpUsd`
(`components/perps/perp-format.ts:42`, `:54`) for every perps price, precisely
because a fixed 2-decimal helper collapses sub-cent coins to `$0.00`.
`perp-trade-form.tsx` imports `formatUsd` (`:68`) and uses it at:

- `:794`, mark price in the ticket header
- `:1431`, trigger price **inside the review `AlertDialog`**
- `:1442`, limit price **inside the review `AlertDialog`**

On a sub-cent coin, a trigger of `0.00042` renders as `$0.00` on the screen the
user is asked to approve. Notional and margin (`:1338`, `:1346`, `:1412`,
`:1416`) are USD amounts where `formatUsd` is correct and should stay.

**Files:** `apps/web-v2/src/components/trade/perp-trade-form.tsx`, plus a
sub-cent case in `components/trade/perp-form-math.test.ts`.
**Size:** S. **Risk:** **REAL-MONEY CONFIRMATION SURFACE.** Three lines, no
logic touched, but it changes what the user reads before approving an order.
This is the highest value-per-line item in the plan.

### F4. Make the labels tell the truth

`signal-feed.tsx:1101-1102` promises the trade form and delivers the chart on
mobile; `:420` says "Prefill the stock trade form with {coin}" and also charts.
`stockPrefillLabel` is imported at `:51` and never used, while `:1101` inlines
the same string by hand. After F1, the split halves need
`feedChartViewLabel(symbol)` and `stockPrefillLabel(symbol)` respectively.

**Files:** `signal-feed.tsx`,
`components/feed/ticker-chart-navigation.test.ts` (add a perp chart-label case).
**Size:** S. **Risk:** low. Not cosmetic: the aria-labels are factually wrong on
mobile and `:51` is a dead import.

### F5. Empty states that name the next action, pointing at signals first

Adopt the mechanic (capture `:136-137`) and invert the content. Theirs says
"Deposit to place your first trade". Ours should lead with the feed, a link back
to `setMobileScreen("markets")` + `setMobileFeedTab("signals")`
(`page.tsx:1665`), with the funding CTA second. That preserves the
signal to thesis to position funnel instead of routing an empty-handed user into
a funding form. Cheapest wins: the author-filter empty state
(`signal-feed.tsx:1181`) gets a "Show all authors" button wired to the existing
`clearAuthors` (`:145`); the signed-out state (`:1159-1160`) gets an actual
sign-in control; the perps-venue empty state gets a "Show all signals" escape
from the `perpsOnly` narrowing.

Also fix the misdirecting one: `positions-panel.tsx:490` tells a perps-only user
to configure Alpaca credentials.

**Files:** `signal-feed.tsx`, `components/trade/positions-panel.tsx`,
`components/trade/perp-positions-panel.tsx`,
`components/charts/portfolio-history-chart.tsx`. **Size:** S. **Risk:** low.

### F6. Touch targets on the social surfaces

`Segment` (`leaderboard-view.tsx:287`) and `FollowButton`
(`follow-button.tsx:91`) are `h-7`, exactly half the `h-11` the mobile shell
standardizes on (`page.tsx:1667`, `:2023`). The pattern to copy already exists
in the same area: `copy-trade-panel.tsx:593` uses
`h-11 w-full ... sm:h-7 sm:w-auto`.
**Files:** `components/copy-trade/leaderboard-view.tsx`,
`components/copy-trade/follow-button.tsx`. **Size:** S. **Risk:** low.

### F7. Mobile Copy screen uses hardcoded viewport math

`renderMobileCopyPanel` is `h-[calc(100dvh-9rem)]` (`page.tsx:1992`) while every
sibling screen uses `h-full` (markets `:1625`, tools `:2008`). The shell already
bounds height (`fixed inset-x-0 bottom-0 top-14`, `:2101`) and, when perps are
configured, renders `MobileVenueBar` above the scroll area (`:2105`). The `9rem`
accounts for neither the venue bar, the `py-3`, nor the nav's safe-area margin.
This is the exact hazard the markets panel documents at `:1621-1624`.
**Files:** `page.tsx`. **Size:** S. **Risk:** low.

### F8. Mobile input font is below 16px in the perp ticket

`ui/input.tsx:11` sets base `text-sm` (14px). The perp size fields override to
`text-sm` (`perp-trade-form.tsx:844`, `:860`), TP/SL fields are `text-xs`
(`:1222`, `:1236`, `:1279`, `:1293`), and the equity stop input is `text-xs`
(`trade-form.tsx:2832`). The equity quantity field is `text-3xl` (`:2475`),
which is why this never surfaced on the equity path. Fix per field, not by
adding a `viewport` export with `maximumScale: 1` to `app/layout.tsx`, which
would disable pinch-zoom app-wide.
**Files:** `perp-trade-form.tsx`, `trade-form.tsx`. **Size:** S. **Risk:** low.

---

## 3. Adopt next: real work, clear payoff

### A1. Make the trade ticket an actual sheet

Change `page.tsx:2119` from an opaque `inset-0` takeover to a bottom-anchored
panel (`inset-x-0 bottom-0 max-h-[85dvh]` plus a scrim), leaving whatever screen
is underneath mounted. Then drop the duplicated header
(`perp-trade-form.tsx:781-797`) when in sheet context, and reconsider the
re-added symbol header (`page.tsx:2121-2141`) and "Change" button
(`:2143-2156`), both of which exist only because the ticket owns the viewport.

Two things the implementation must not assume:

- **The chart is not necessarily behind it.** The sheet also opens from the
  bottom nav on any mobile screen (`page.tsx:2223` and `:3066` to
  `openTradeSheetForVenue` at `:726`), so the surface behind is often the
  signals feed. That is fine, arguably better, but the code must not depend on
  `mobileScreen === "chart"`.
- **If you additionally make the ticket land over the chart** (setting
  `setMobileScreen("chart")` inside the narrow-viewport branch of
  `openTradeSheetOnNarrowViewport`, `:573-580`), note that it mounts a live
  `VenueAwareSignalFeed` behind the sheet (`page.tsx:1952-1958`). CLAUDE.md's
  audit-M3 rule forbids adding polling or subscriptions to a shell hidden on the
  current viewport. This is adjacent enough to require a deliberate decision,
  not a silent two-line edit. Also note it would not reach
  `openTradeSheetForVenue`'s perps branch (`:727`), which calls
  `setMobileTradeSheetOpen(true)` directly.

**Files:** `page.tsx`, `perp-trade-form.tsx`, and
`apps/web-v2/src/app/app/page-layout.test.ts` (see §6).
**Size:** M. **Risk:** medium. Presentation only, no path to `submitPerp` or
`submitOrder`, but it restructures the container every mobile order is placed
from.

### A2. Balance row and current position in both tickets

Bullpen shows `Available 0.00 USDC` with an inline `+`, and
`Current Position 0 ETH` (capture `:66-67`). We show neither, in either ticket,
despite already having both values in scope.

- **Perps balance:** `accountContext` is destructured at
  `perp-trade-form.tsx:201` and `hlBalanceUsd` never appears in the file, though
  it is on the context (`lib/venue-context.tsx:71`) and already rendered in the
  desktop header (`page.tsx:2309`). **Label it "Balance", not "Available":**
  `packages/hyperliquid/src/client.ts:546-552` documents `accountBalanceUsd` as
  total USDC collateral, not withdrawable or free margin.
- **Equity buying power:** `accountQuery` is destructured at
  `trade-form.tsx:981` and never referenced again. Render
  **`nonMarginableBuyingPower`**, not `buyingPower`:
  `apps/api/src/routers/positions.ts:718-728` documents the latter as
  margin-inflated and misleading to surface, and `page.tsx:526-529` already
  follows that rule.
- **Current position:** `activeEquityPosition` is computed at
  `use-trade-quotes.ts:147-157`, destructured at `trade-form.tsx:987`, and never
  used. The perp ticket has no position awareness at all, so Reduce Only
  (`perp-trade-form.tsx:1176-1183`) gives no indication of what is being reduced.

**Files:** `perp-trade-form.tsx`, `trade-form.tsx`.
**Size:** M. **Risk:** low as read-only displays of already-fetched data. Ships
two numbers that must be the *right* two: shipping `buyingPower` or labeling HL
collateral "Available" would be worse than showing nothing.

### A3. State-aware equity CTA

Lift the credential and account branches of `getSubmitBlocker`
(`trade-form.tsx:902-907`) into the button label (`:3398-3402`), alongside the
sign-in state already there, mirroring the idiom the chart CTA already uses
(`page.tsx:1984`, "Connect Broker to Trade"). Then shrink the ~48-line
credential card (`:2193-2240`) to one line.
**Files:** `trade-form.tsx`. **Size:** S. **Risk:** low, label and layout only,
no change to what submits.

### A4. Compact pill row for the perp ticket

Bullpen puts leverage, margin mode and order type in one pill row
(capture `:63-65`). We use three separately labeled blocks: Margin Mode
(`perp-trade-form.tsx:873-904`), Order type (`:907-1023`), Margin & leverage
(`:1104-1167`), on a screen where the ticket already scrolls. Replace with three
pills opening the existing controls in place; fields and `resolvePerpOrderType`
wiring untouched. Sequence this **after** A1, since `max-h-[85dvh]` tightens the
vertical budget and raises the payoff. Perps-only by construction:
`VenueAwareTradeRail` branches at `page.tsx:2687`.
**Files:** `perp-trade-form.tsx`. **Size:** M. **Risk:** low.

### A5. Turn Search into a browse surface with live prices

Three changes to the same screen:

- **Stop rendering the suggestion list as an overlay.** Pass the existing
  `className` escape hatch (`terminal-market-search.tsx:253`) from the mobile
  call site (`page.tsx:1775-1786`) so the list is static, full-height and the
  `flex-1` child of the section.
- **Put a price on every row.** No API change needed for v1, join client-side
  after `markets.search` resolves. Stocks: `quotes.getChartQuotes`, capped at 30
  symbols (`apps/api/src/routers/quotes.ts:669-677`), well above the 8-row
  default suggestion limit (`terminal-market-search.tsx:48`), and it runs on
  `createMasterAlpacaClient()` (`quotes.ts:679`) so prices render even for a
  perps-only user with no Alpaca connection. Perps: `hyperliquid.marketStats`,
  already fetched by `perp-symbol-universe.tsx:41` and `watchlist-panel.tsx:123`.
  Format with `formatPerpPx`/`formatPerpChangePct` for perps and
  `formatUsd`/`formatSignedNumber` for stocks, per the CLAUDE.md formatter rule.
- **Give the empty query a default browse state.** Blank the input on entry
  (make `openMobileSearch`, `page.tsx:738-743`, match
  `openMobileSearchForNewSymbol`, `:745-749`, which today produce two different
  behaviors from two entry points), then render venue-tagged Recents followed by
  Market Pulse rankings. `marketPulse.overview` already ships trending and
  gainers per venue with per-row View/Trade actions
  (`market-pulse-rankings.tsx:42-94`). Note perps "Most Active" is derived
  client-side from the heatmap (`market-pulse-utils.ts:40-46`), not an API
  field, so go through `getVenueRankings` rather than reading
  `overview.perps.mostActive`.

**Files:** `page.tsx`, `components/terminal/terminal-market-search.tsx`,
`components/terminal/market-pulse-rankings.tsx`.
**Size:** L. **Risk:** low. `MarketSuggestionsList` is shared with the desktop
chart-bar search (`terminal-market-search.tsx:592-601`), so every size and
layout change must go through the `className` prop or a size variant, never by
editing `:212` or `:311` directly, which would inflate the desktop dropdown.

### A6. Search tap targets and activation

Single-line suggestion rows (`px-2 py-1.5` + `text-xs`,
`terminal-market-search.tsx:311`, `:316-325`) land near 30px. That is exactly
the perp-only case, since perps have no `name`; two-line stock rows clear 44px.
The venue chip is `px-1.5 py-0.5 text-[10px]` (`:212`), roughly 18px.

Separately, both the row button (`:332-336`) and the venue chip (`:224-227`)
commit on `onMouseDown` with `preventDefault()` and have no paired `onClick`.
There is a keyboard path through `handleKeyDown` (`:145-168`), but
`resolveEnterSelection` returns `ambiguous` for a dual-listed symbol under
filter "all" (`lib/market-selection.ts:200-210`), so **for a dual-listed ticker
there is no keyboard or assistive path to commit at all**, and the only control
that can disambiguate is mousedown-only. The recents list in the same file
already fixed this with a paired handler and an explicit comment (`:578-586`).
Dual listing is real and documented in-repo (`signal-feed.tsx:461-470`).
Consider splitting a dual-listed symbol into two full-width rows on mobile
(`AAPL · Stock`, `AAPL · Perp`) rather than asking for an 18px chip tap.

**Files:** `components/terminal/terminal-market-search.tsx`, `page.tsx`.
**Size:** M. **Risk:** low.

### A7. Perps are invisible in the mobile portfolio (correctness, not design)

None of the three mobile Info panels is venue-aware. `PositionsPanel`
(`page.tsx:2036-2047`), `OpenOrdersPanel` (`:2050-2055`) and
`PortfolioHistoryChart` (`:2058`) are all Alpaca-only; the latter is Alpaca-only
by construction (`portfolio-history-chart.tsx:391-393`, keyed on
`credentialId`). The desktop has purpose-built wrappers the mobile shell simply
does not use: `VenueAwareRightPositions` (`page.tsx:2733`),
`VenueAwareRightOrders` (`:2752`), `VenueAwareBottomContent` (`:2770-2866`,
mounting `PerpBottomPanel` at `:2839`). Flip `MobileVenueBar`
(`venue-switch.tsx:114-129`) to Perps on a phone, hold a 5x ETH long, open Info,
and you get an Alpaca empty state.

**Interim fix, cheap:** swap `page.tsx:2036` and `:2050` to the desktop
wrappers. Both are inside the `VenueProvider` tree (`:2206-2582`), which also
wraps the mobile shell. **Caveat:** those wrappers are venue-*filtered*
(`:2740-2749`), so on mobile they would hide Alpaca equity positions whenever
the venue switch is on Perps. That trades one invisibility bug for its mirror.
Ship it only as an explicitly interim step.

**The real fix (A8):** one venue-*spanning* mobile portfolio.
`PerpPositionsPanel` is already mobile-ready and only needs mounting:
`@container/perppos` at `perp-positions-panel.tsx:344` with a stacked
two-column label grid under 520px at `:434-466`.

**Files:** `page.tsx`. **Size:** S interim, M proper. **Risk:** medium as
interim (regresses equity visibility on the perps venue), low as proper.

### A8. One mobile portfolio screen spanning both venues

On desktop, venue is a workspace mode. On a phone the user has one portfolio and
one question, so the mobile portfolio must be venue-spanning, not venue-filtered.
Adopt Bullpen's shape (capture `:149-155`): total value, then a drill-down row
per venue with its own value and chevron.

- **Total value** = Alpaca `portfolioValue` + HL account value. Both already
  poll at page level (`page.tsx:516-524` and `:489-496`), so no new queries.
  Implementation note: `hlBalanceUsd` is typed `string | null`
  (`apps/api/src/routers/hyperliquid.ts:82`), so summation needs an explicit
  parse.
- **Two venue rows:** `Stocks & options - $X ›` to `PositionsPanel`,
  `Perps - $Y ›` to `PerpBottomPanel`, which already carries Positions/History
  tabs (`components/perps/perp-bottom-panel.tsx:31-73`).
- **Do not merge stock and perp rows into one table.** The desktop already made
  that call deliberately and documented why (`page.tsx:2846-2852`: shares versus
  size/leverage/liquidation/funding). That is the equities-safety guard, keep it.

**On the money-action row: proceed with care.** ⚠️ **REAL-MONEY PATH.**
Re-mounting `PerpsOnboardingCard` (`components/perps/perps-onboarding-card.tsx`)
is not an inert move: it runs an auto-enable effect (`:478-495`) that fires
`enableMutation.mutate({ masterAddress })` (`:352`), provisioning the
server-controlled agent wallet on first touch. Mounting it on a portfolio screen
every user visits changes *when* wallet provisioning happens for the entire user
base. Gate it behind an explicit tap, never a mount. Also note there is no
withdraw or HL to Arbitrum transfer path in the codebase:
`lib/hyperliquid-deposit.ts` exports only
`readPerpsWalletBalancesByAddress` (`:112`) and `depositUsdcToHyperliquid`
(`:160`), and the agent wallet carries a withdrawal-DENY policy
(`apps/api/src/routers/hyperliquid.ts:105-108`). A four-up
Deposit/Withdraw/Transfer/More row is **not** buildable today.

**Files:** `page.tsx`, `components/perps/perp-bottom-panel.tsx`.
**Size:** L. **Risk:** medium, with the onboarding-card mount as the specific
real-money hazard.

### A9. Balance as the nav label, header metrics hidden below xl

`MOBILE_NAV_ITEMS` is a module-level const (`page.tsx:3062-3069`) consumed by
both `MobileBottomNav` (`:3089`) and `MobileNavMenu` (`:3152`), so widening
`MobileNavItem.label` (`:3051-3058`) to accept a render function upgrades both
at once; the value has to be threaded in as a prop, the const cannot close over
`headerPortfolioValue`. Then add `hidden xl:flex` to the header metric cluster
(`:2287-2314`), whose styling is already xl-only.

**Two constraints.** (1) That header cluster is currently the *only* place Perps
Balance and Buying Power appear on mobile, so hiding it before the nav label
ships is a straight regression. Land the label first. (2) The "tools" screen
also hosts the AI tab (`:2060-2072`), so a pure-balance label mislabels a
quarter of the screen. Either accept that or move AI out.

**Files:** `page.tsx`. **Size:** M. **Risk:** low if sequenced as stated.

### A10. Pull the leaderboard inside the mobile shell

Today the leaderboard is effectively unreachable on mobile. It is not in
`MOBILE_NAV_ITEMS` (`page.tsx:3063-3069`) or `MobileNavMenu` (`:3152-3173`); the
header link lives in `HeaderMenu` (`:3217`) whose trigger is
`hidden shrink-0 lg:inline-flex` (`:3229`). The single mobile path is the
"Top Traders" link in the Copy panel header (`copy-trade-panel.tsx:588-598`),
and `/leaderboard` is a separate route with its own header and no bottom nav, so
navigating there exits the shell and discards `mobileScreen`, `mobileFeedTab`
and `selectedSignal`.

Do **not** add a sixth bottom-nav item; the grid is `grid-cols-5`
(`page.tsx:3088`) and all five are load-bearing. Give `renderMobileCopyPanel`
(`:1991-2004`) a `Feed | Top Traders` header. Keep `/leaderboard` for desktop
and deep links. **Constraint:** `LeaderboardView` already renders its own Tabs
(X Callers / Users, `leaderboard-view.tsx:57-69`); nesting gives three stacked
control rows on a 375px screen once `MobileVenueBar` is showing. Merge the two
levels into one four-way segmented control rather than nesting.
**Files:** `page.tsx`, `components/copy-trade/leaderboard-view.tsx`.
**Size:** M. **Risk:** low.

### A11. Pinned "YOU" row on the leaderboard

Add a `me` field to `leaderboard.users` computed for `ctx.userId` regardless of
rank, carrying its true rank index, rendered pinned in `UsersTab`
(`leaderboard-view.tsx:193-214`). The justification is stronger for us than for
Bullpen: `limit: 25` (`use-leaderboard-view.ts:97`) combined with
`anonymizeTrader()` (`apps/api/src/routers/leaderboard.ts:525`;
`lib/trader-identity.ts:56-66`, rendering users as e.g. `SwiftFalcon412`) means
a signed-in user **cannot locate themselves at all**, not by name and not at
rank 40. Keep the honest caption (`leaderboard-view.tsx:42-43`) attached: the
users board is built from shared trades only, so most pinned rows will
legitimately read "no shared trades yet".
**Files:** `apps/api/src/routers/leaderboard.ts`,
`components/copy-trade/leaderboard-view.tsx`,
`components/copy-trade/use-leaderboard-view.ts`.
**Size:** M. **Risk:** low.

### A12. Feed hygiene

The infinite query refetches every loaded page every 10s
(`signal-feed.tsx:538`, and the file's own comment at `:768-771` says so), which
at the 5-page cap (`MAX_AUTO_FETCH_PAGES = 5`, `:62`) is 5 requests per tick,
plus quotes at 30s (`:718`) and perp stats at 30s (`:506`). `grep
visibilitychange` over `components/feed/` returns nothing. Gate on
`document.visibilityState`; only page 1 needs 10s cadence. Add an "N new
signals" pill on top-of-list insert instead of silently prepending. Add
`overscroll-contain` to the feed's own scroller (`:915`), which the shell
scroller already has (`page.tsx:2106`).
**Files:** `signal-feed.tsx`. **Size:** S. **Risk:** low.

### A13. Price on every feed row

`MAX_QUOTE_SYMBOLS = 30` (`signal-feed.tsx:79`) and `quoteSymbols` breaks at 30
unique symbols (`:699-709`), while up to 150 signals load. Everything below the
first ~30 tickers renders a bare `Copy $SYM`. Perp rows are unaffected, since
`hyperliquid.marketStats` takes no arguments (`:504-509`), so scrolling produces
a feed where perp calls keep prices and equity calls stop having them.

**Do not just raise the constant.** `quotes.getChartQuotes` validates `symbols`
with `.max(30)` (`apps/api/src/routers/quotes.ts:673-675`) and would reject the
input. Two viable shapes: (1) keep 30 and make the window follow scroll position
instead of load order, no API change; (2) raise both the client constant and the
router cap, accounting for one `client.getSnapshot()` per symbol
(`quotes.ts:684-686`), so 60 symbols is 60 Alpaca calls per 30s tick per viewer.
Do option 1 first.
**Files:** `signal-feed.tsx`. **Size:** M. **Risk:** low.

---

## 4. Strategic: where signal-first lets us beat them

These are not ports. Bullpen structurally cannot build them, because a wallet
never states a reason.

### S1. Carry the caller's thesis onto the chart and into the CTA

When the user arrives at the chart from a signal, the pinned CTA
(`page.tsx:1976-1986`) currently reads `Trade {SYMBOL}`. It could read the
caller and the time: `group.authorName` (`signal-feed.tsx:997`) and
`group.timestamp` (`:1004`) are both in hand. Bullpen's pinned CTA can only ever
say Long or Short.

**Two hard constraints, both learned the expensive way.**

1. **Direction must be gated on presence, not derived.**
   `classifySignalInstrument` resolves `side: short ? "sell" : "buy"`
   (`packages/utils/src/utils/signal-instrument.ts:170`), which means **absent
   direction metadata resolves to "buy"**. Most X-relayed signals carry no
   direction field. Using `signalSideFromMetadata()` (`:190`) unconditionally
   would print "Long NVDA, @X's call" on signals where nobody said long, one tap
   from an order ticket. Read `classifySignalInstrument(metadata).direction` and
   render direction only when it is non-null.
2. **"-1.2% since the call" is not computable today.**
   `quotes.getChartQuotes` returns `{symbol, last, change, changePercent}`
   (`quotes.ts:698-703`), all current-versus-previous-close. There is no price at
   the signal's timestamp anywhere in the feed's data. This is the single
   highest-value addition in the whole plan and the most honest number we could
   show, but it requires a new historical-bar lookup keyed on `group.timestamp`.
   Scope it as its own change, not a formatting tweak.

Also worth doing here: the chart screen currently never renders the signal body
(`page.tsx:1900-1986`), so the thesis is only reachable via the in-card
"View more" toggle (`signal-feed.tsx:214-230`). A chart-screen signal header
would fix that, and is a precondition for tightening the feed's `line-clamp-4`
(`:200`) to save vertical space.

**Files:** `page.tsx`, `signal-feed.tsx`, plus a new quotes procedure for the
since-call number. **Size:** L. **Risk:** medium. The CTA sits adjacent to the
order ticket, so a fabricated direction is worse than no direction.

### S2. Author as a first-class object

The author name is a `<span>` (`signal-feed.tsx:991-998`). `useHiddenAuthors`
(`:107-148`) is hide-only and localStorage-only, surfaced as 28px
`DropdownMenuCheckboxItem` rows (`:862-897`; `ui/dropdown-menu.tsx:83`) inside a
scroll-within-scroll. There is no "only this caller", no mute-from-row, no
follow. Make the author name a tap target opening a caller sheet: recent calls,
measured hit rate, "Only show this caller", "Mute", Follow. Bullpen's analogue
is the leaderboard's inline Follow (capture `:179-181`), but theirs attaches to
an address and ours attaches to a person with a published record.

**Scope flag:** moving hidden-authors off localStorage (`:65`) onto the server
means a new user-preference table, which per CLAUDE.md requires a Drizzle schema
change, `db:generate`, a reviewed migration and a production
`DATABASE_URL_DIRECT` run. Do not fold that into a UI PR.
**Files:** `signal-feed.tsx`, plus a new caller sheet component.
**Size:** L. **Risk:** low for the UI, medium for the persistence half.

### S3. Signals and People as search tabs

A5 gives us grouped browse tabs. Bullpen's set is All/Perps/Predictions/Spot/
Onchain/**Wallets**. Ours should be All/Stocks/Perps/**Signals**/**People**:
recent signals mentioning the query, and the callers who published them. Their
Wallets tab shows what an address holds; ours shows what a person said and why.

**Implementation constraint:** give the Search screen its own local
`MarketSearchFilter` state feeding `useMarketSearch({ filter })`
(`terminal-market-search.tsx:103-107`) rather than reading the global
`searchFilter` from `useVenue()` (`trading-responsive-shell.tsx:49`). Today
`MobileVenueBar` scopes the search *and* flips the traded venue in one action
(`venue-switch.tsx:75-77`), and because the mobile chart resolves its symbol from
the venue (`trading-responsive-shell.tsx:53`), tapping "Stocks" to narrow a
search switches the chart away from the perp you were looking at. Do **not**
strip `setVenue` from `venue-switch.tsx:77`, it is the only explicit venue
switcher on mobile; decouple by adding the local filter instead.

**Files:** `page.tsx`, `terminal-market-search.tsx`, plus a signals/people
search endpoint. **Size:** L. **Risk:** low.

### S4. Claim your caller row

If a signed-in user's X handle matched an ingested caller key
(`followTarget.key` = `normalizeAuthorKey(authorName)`,
`apps/api/src/routers/leaderboard.ts:164`, emitted at `:669`), they would
inherit their measured forward-return row. Bullpen's equivalent is the "Connect
your X Account" banner (capture `:173`), but theirs connects identity to wallet
PNL; ours would connect identity to a published, measured call record. That is
the harder thing to fake and the better thing to own.

**Blunt scoping note:** there is **no X account linkage anywhere in the app**. A
repo-wide grep of `apps/web-v2/src` for `twitter` / `xHandle` / `connectX` /
`oauth` returns only prose in `app/guide/page.tsx:688,692` and Google/Privy
login plumbing (`components/providers.tsx:46-48`, `lib/auth-client.ts:11`). This
is new capability, not a re-skin, and it needs its own design and security pass.
**Size:** L. **Risk:** medium (new auth surface).

### S5. Outbound source link on the leaderboard row

Smaller, and a direct expression of the thesis. The app already links outward to
the source post in three places (`signal-feed.tsx:234-246`,
`copy-trade-panel.tsx:994`, `app/leaderboard/x/[authorKey]/page.tsx:216-226`),
but the aggregate leaderboard row links only inward
(`leaderboard-row-cells.tsx:150-159`). `schema.signals.url` is selected at
`leaderboard.ts:603` and retained per call on the bucket (`:191`, `:194`), but
the row object pushed at `:668-679` does not carry it, so this is a router
output plus type change, not a UI-only tweak.
**Files:** `apps/api/src/routers/leaderboard.ts`,
`components/copy-trade/leaderboard-row-cells.tsx`. **Size:** S. **Risk:** low.

---

## 5. Explicitly rejected

**Chart-first as the landing screen.** The capture's own anti-pattern list says
it (`:118-119`) and it is the core product disagreement. The signal feed is why
the user opened the app. `mobileScreen` stays `"markets"`.

**Burying social under trading.** Their Tracker/Leaderboard placement is the
inverse of our thesis (capture `:120-121`). A10 pulls the leaderboard *up* into
the shell rather than down under a hamburger.

**Crypto-only symbol grammar.** `BASE-QUOTE` names and always-on leverage badges
would misrepresent an equity ticket (capture `:122-123`). Also flagged by the
capture itself.

**Dollar-denominated size for equities.** `apps/api/src/routers/orders.ts` types
quantity as `z.number().int().positive()` at `:353`, `:1012`, `:1203`, `:1456`,
`:1461`, `:1663`, and the string "notional" appears nowhere in the file. A
`$ ⇄ shares` switcher would require changing the submission schema, which is a
real-money path change for a convenience feature. A `$ → shares` *calculator*
writing whole shares into the existing field would be fine, but that is a
different, smaller feature.

**A size-% slider on the perp ticket, as specified.** ⚠️ **REAL-MONEY: this
would write the submitted size.** The obvious formula
`(hlBalanceUsd × leverage × pct) ÷ mark` is unsafe. `hlBalanceUsd` is a `string`
(`venue-context.tsx:71`) needing a parse, and it is **total** collateral, not
free margin (`packages/hyperliquid/src/client.ts:546-552`). Sizing off it with
positions already open over-sizes and gets rejected at Hyperliquid. There is a
second trap: the only `<Slider>` in the perp form (`perp-trade-form.tsx:1118`)
is bound to **leverage**, and the adjacent "Max" button (`:1152-1165`) sets max
leverage, not max size, so Bullpen/HL muscle memory already misfires here.
Revisit only after sourcing withdrawable margin, with the pure function in
`perp-form-math.ts` and tests alongside.

**Replacing the equity ticket's OCO-by-default exit plan with Bullpen's
collapsed TP/SL model.** `orderType: "OCO"` (`trade-form.tsx:447`),
`trailingEnabled: true` (`:468`) and `railShowExitPlan` starting `true` (`:727`)
make the ticket tall on first open, and that is a deliberate product bet, not an
oversight. The right fix is much smaller: `railShowExitPlan` is plain
`useState`, not `useCollapsible` (`ui/section-collapse.tsx:17`), so a mobile
user re-collapses it on every ticket. Persist the choice, keep the default.

**A top-3 podium on the leaderboard.** Podium cards work when the metric is one
verified PNL number. Ours is `avgForwardReturnPct` at a user-chosen horizon over
a `measuredCallCount/callCount` denominator, with three degraded modes surfaced
as banners (`leaderboard-view.tsx:120-136`) and a 5,000-signal scan cap that can
truncate the ranking (`leaderboard.ts:610-615`). A podium asserts confidence the
data does not carry. Keep the existing top-3 rank-badge accent
(`leaderboard-row-cells.tsx:81`) and spend the space on the caveat plus A11's
pinned row.

**A persistent mobile market tape.** `TerminalMarketTicker` is venue-aware
(`terminal-market-ticker.tsx:117-125`) and could be pinned under
`MobileVenueBar`, but it adds an `allMids` 10s poll plus a `getChartQuotes` 30s
poll plus a watchlist query to every mobile screen (`:129-133`, `:144-152`,
`:154-159`), which runs straight into CLAUDE.md's audit-M3 rule. The capture
does not actually support it either: the "ambient" pattern (`:111-113`) is about
the wallet balance and money actions, not price. Revisit only if A5 leaves a gap.

**Un-gating browse for signed-out users** (Bullpen leaves charts, search and
markets browsable and gates only the wallet, capture `:86-88`). Deferred, not
rejected on merit. `markets.search` is a `protectedProcedure` with an explicit
"only used inside the authed terminal" comment
(`apps/api/src/routers/markets.ts:98-101`), and A5's price join would also need
`quotes.getChartQuotes` opened (`quotes.ts:669`), which runs on **master Alpaca
credentials**. That is an authorization-boundary change needing rate limiting
and a security review, not a mobile-UI PR. Route it separately.

**An "Enable perps" inline button in the feed.** The `Enable perps to copy`
tooltip fires when `disabled = !PERPS_ENABLED || !onCopy`
(`signal-feed.tsx:323`). `PERPS_ENABLED` is a build-time constant
(`lib/perps-config.ts:15`, `!!process.env.NEXT_PUBLIC_PRIVY_APP_ID`) and
`onCopy` is always supplied on both mobile mounts, so on mobile the disabled
state means "this deployment has no Privy app id", which the user cannot fix.
The real defect is that a tooltip is invisible on touch. Replace it with visible
inline text, not an action button.

**Restructuring the leaderboard row layout.** `XCallerRowCard`'s metrics
container is `flex w-full items-center justify-end gap-3 sm:w-auto`
(`leaderboard-row-cells.tsx:173`), which already forces metrics onto their own
line below `sm`, so Follow (`:172`) is already the trailing right-aligned
element at 375px. Only the `h-7` to `h-11` size fix (F6) is warranted.

---

## 6. Sequencing, and one blocker to clear first

**Order:** F3 (real-money confirmation surface, three lines) → F1 + F2 + F4 (the
complaint, one PR) → F5, F6, F7, F8 → A1 → A3, A2 → A7 interim, then A8 → A5,
A6 → A9, A10, A11 → A12, A13, A4 → S1 → S2, S3, S5 → S4.

**The blocker: source-string tests.** Two `readFileSync` + `toContain` test
files sit directly on top of this work.

- `apps/web-v2/src/components/feed/signal-feed.test.ts` reads
  `signal-feed.tsx` as a string (`:12-15`) and asserts on the exact
  `Copy ${t.symbol}` template, the `title=` template, icon class strings, and
  literal className strings including
  `"min-h-11 text-muted-foreground hover:text-foreground xl:min-h-6 xl:text-[11px]"`.
  F1's chip restructure and F4's label change both break it.
- `apps/web-v2/src/app/app/page-layout.test.ts` reads `page.tsx` as a string
  (`:8`) with ~194 `toContain` assertions, including the mobile-shell and
  venue-aware blocks and the trade-sheet markup A1 rewrites.

CLAUDE.md (audit H7) is explicit: replace those with behavioral tests, and the
source-string allowlist must shrink, never grow. **Converting the affected
blocks to render plus `getByRole` assertions is step zero**, before F1 and
before A1. The pure-helper tests in the same files import real modules and stay.

**And the size rule.** `signal-feed.tsx` is 1,191 lines, well past CLAUDE.md's
~500-line threshold. F1 and the density work are the natural moment to extract
`SignalCard` and `useSignalGroups`, after the behavioral tests land.

---

## 7. What we do not know

- **Whether the complaint reproduces on the stocks venue.** The perp path is a
  confirmed defect. The equity path charts today, so if the user is on stocks
  what they are reacting to is the label plus the watchlist row. Worth
  confirming with them before sizing F1's rollout, though the fix does not change
  either way.
- **All pixel budgets in this document are estimates from class stacks**, not
  browser measurements. The class stacks are verified; the arithmetic is not. Any
  claim of the form "recovers N px" was deliberately cut rather than guessed.
- **D3 (the timestamp button) is inferred, not exercised.**
  `SignalTimestamp` renders a `<button>` whose only handler is
  `onClick={(e) => e.stopPropagation()}` (`signal-feed.tsx:282`), styled
  `cursor-default` (`:284`), inside a Radix Tooltip that reveals the absolute
  date (`:291`). Touch has no hover, so this most likely reads as a button that
  does nothing, but that was not verified in a browser.
- **Four `stopPropagation` calls guard a handler that no longer exists**
  (`signal-feed.tsx:218`, `:237`, `:249`, `:282`), and two comments describe a
  card click that is not in the file (`:154-155`, `:265-267`). F1 either makes
  them live again (if the card gets a tap target) or they should be deleted.
- **`showPricePills` can never be false.** It initializes `true`
  (`signal-feed.tsx:501`) and its only setter call is `setShowPricePills(true)`
  (`:759`), so the `"price_pills"` subheader action is a no-op on every
  viewport and the guard at `:1106` is dead. Decide whether the toggle is a
  feature or should be removed, rather than preserving it by accident through
  F1.
- **Two currency-formatter rule violations** noticed in passing, outside the two
  sanctioned exceptions in CLAUDE.md (audit M16): a local `formatCurrency` using
  inline `Intl.NumberFormat` at `components/trade/positions-panel.tsx:306-316`,
  and `formatSignedCurrency` at
  `components/copy-trade/leaderboard-row-cells.tsx:24-34`. Fold into whichever
  PR touches those panels.
