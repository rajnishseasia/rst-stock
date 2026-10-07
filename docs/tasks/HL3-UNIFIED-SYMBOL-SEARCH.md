# HL-3: Unified single-symbol search across stocks and perps

## The old model vs the new model

Before: the user first picked a venue (Stocks or Perps) with a toggle, then
searched inside that venue. Two symbol states, two search boxes, two commit
handlers, and a hard either/or terminal.

Now: there is ONE search box. The user types a symbol, sees whether it is
tradable as a Stock, a Perp, or both, picks it (or a specific venue chip on a
both-venues row), and lands in the right venue automatically. The old toggle is
demoted to a compact filter + venue indicator.

## Data flow

```
type a symbol
   -> markets.search(q, venues?)            (backend merge, venue-tagged rows)
      -> suggestions: { symbol, name, venues: ("stocks"|"perps")[] }
         -> pick a row / chip / Enter
            -> resolveEnterSelection(venues, filter)   (unique | ambiguous | none)
               -> selectMarket({ symbol, venue })      (ONE action)
                  -> sets activeSymbol OR activeCoin  AND  flips venue
```

### Backend (`apps/api`)

- `markets.search` (`routers/markets.ts`, registered in `routers/index.ts`)
  merges Alpaca equity matches (the same shared `getCachedAssets` cache the
  watchlist `symbols.search` uses) with the Hyperliquid universe (the same
  source `hyperliquid.meta` reads, wrapped in a 5-minute in-process cache).
  Each result is `{ symbol, name, venues }`. A symbol on both venues collapses
  to ONE row whose `venues` has both. Both sources degrade independently: if
  Alpaca creds or the HL universe are unavailable, that side just contributes
  no matches.
- Pure, unit-tested logic lives in `apps/api/src/lib/markets/market-search.ts`:
  - `resolveSymbolVenues(symbol, { equityCatalog, hlUniverse })` -> which venues
    list a symbol (case-insensitive; delisted HL assets excluded). Backs both
    search tagging and the wrong-venue states.
  - `mergeMarketSearchResults(...)` -> the merge/dedup/rank (both-venue collapse,
    equity metadata wins the shared row, exact/prefix ranking, optional `venues`
    filter).
  - `rankEquityMatches(...)` -> the tiered equity ranking, shared with
    `symbols.search` so the two stay consistent.

### Frontend (`apps/web-v2`)

- `lib/market-selection.ts` (pure, unit-tested): `marketSelectionTarget` and
  `applyMarketSelection` (stocks -> `activeSymbol`, perps -> `activeCoin`, plus
  the venue flip), `resolveEnterSelection` (bare-symbol Enter), and
  `wrongVenueNotice` (HL8 messaging).
- `lib/venue-context.tsx` gains `searchFilter`/`setSearchFilter` and
  `selectMarket({ symbol, venue })`. `selectMarket` flips the venue (persisted,
  unless the provider is locked) and routes the symbol to the page-level commit
  handler for that venue (`onSelectStockSymbol` = `handleTradeSymbolCommit`,
  `onSelectPerpCoin` = `handleCoinCommit`). This collapses the split commit
  handlers for the search path.
- `components/terminal/terminal-market-search.tsx`:
  - `useMarketSearch` headless hook (debounce, `markets.search`, keyboard nav).
  - `MarketSuggestionsList` venue-tagged dropdown (Stock/Perp chips + inline
    wrong-venue notes; both-venue rows expose a chip per venue).
  - `TerminalMarketSearch` desktop chart-bar box, rendered via
    `TerminalChartPanel`'s new `headerSearch` slot so it sits next to HL-2's
    quote strip. The plain `InputGroup` stays as the fallback for surfaces that
    don't wire the unified search.
- Mobile: `trading-responsive-shell.tsx`'s `useMobileShellSubscriptions` builds
  the mobile search from `useMarketSearch` and exposes a venue-aware
  `pickMarket`; the mobile search screen renders `MarketSuggestionsList`.

## Both-venue selection (never guess)

- A single-venue suggestion row is one click target.
- A both-venue row is inert as a whole; each venue is a clickable chip, so the
  user picks explicitly.
- Bare symbol + Enter:
  - unique venue -> select it,
  - both venues + "All" filter -> ambiguous (dropdown stays open; the user
    taps a chip), never a silent guess,
  - a concrete Stocks/Perps filter counts as the explicit choice, so a
    both-venue symbol resolves to the filtered venue,
  - neither -> a clear "Not tradable on Ready Set Trade." empty state.

## Demoted toggle (`venue-switch.tsx`)

The Stocks/Perps toggle becomes a compact three-way control: `All | Stocks |
Perps`. It sets `searchFilter` (which scopes the search dropdown) and, for a
concrete Stocks/Perps choice, ALSO flips (and persists) the traded venue, so
direct venue switching is not regressed. A small dot indicates the active
trading venue. Hidden entirely when perps aren't configured. `MobileVenueBar`
renders the same control full-width at the top of the mobile shell.

## Wrong-venue messaging (HL8)

Availability is derived from existing signals: stocks are usable once an Alpaca
account is connected (`selectedCredentialId`); perps are usable once the HL
wallet is enabled (`hyperliquid.status.enabled`). When a user picks a venue that
isn't usable, `wrongVenueNotice` surfaces an inline note:

- HL-only user picks a Stock -> "Stock trading needs a connected Alpaca account.
  Add one in Settings."
- Perps-not-enabled user picks a Perp -> "Perps aren't enabled yet. Enable Perps
  in Settings to trade this market."

The pick still goes through so the user lands on the connect/enable CTA.

## Sectioned "All" positions/orders

`VenueAwareBottomContent` / `VenueAwareBottomHeader` gain a top-level view
selector: `All | Stocks | Perps` (default `All`), independent of the traded
venue and shown only when perps are configured.

- `All` stacks a labeled **Stocks** section (`PositionsPanel` +
  `OpenOrdersPanel`) over a labeled **Perps** section (`PerpPositionsPanel` +
  `PerpFillsPanel`). Every panel renders UNCHANGED. Stock rows (shares) and perp
  rows (size / leverage / liq / funding) are NEVER merged into a shared table,
  they just live under their own section header.
- `Stocks` keeps the existing `positions / orders / P&L` sub-tabs.
- `Perps` is the existing `PerpBottomPanel`.
- When perps aren't configured, the bottom is stocks-only exactly as before.

## Deferred to a follow-up

- Recents / watchlist rows on mobile still open as stocks (the venue-aware pick
  covers the unified-search path).
- No fuzzy matching or per-venue price/volume in suggestion rows yet.
- The "All" bottom view uses fixed-height stacked sections; a fully fluid
  splitter for the two sections is out of scope here.
