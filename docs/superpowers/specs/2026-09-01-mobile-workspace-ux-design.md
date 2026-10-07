# Mobile Workspace UX Hardening Design

**Date:** 2026-09-01

## Goal

Make Ready Set Trade's mobile workspace fully usable from 320px upward while
preserving the production trading, copy, auth, and data controllers introduced
by PR #227. Bullpen is the interaction reference, not a product or visual clone.

## Observed Problems

- The shell repeats account and venue context, reducing the useful viewport.
- Markets, Copy, Account, and Search introduce internal page-sized scrollers
  inside the shell's existing scroll owner.
- Account values, tabs, and portfolio tables clip or overlap at narrow widths.
- Copy rankings are buried beneath status and configuration content.
- Chart and trade surfaces devote too much height to labels before the primary
  task, while market data and key actions truncate.
- Drawers, search, and trade overlays work but do not share one predictable
  mobile interaction model.

## Interaction Model

- The mobile shell owns the only page scroll. A child may scroll only when it
  is a bounded overlay such as search, menu, order book, or trade review.
- Keep a compact persistent top bar and bottom navigation. Account context is
  concise and must never truncate critical numeric values.
- Search is a full-screen overlay with a fixed search field, horizontally
  scrollable filters, and dense result rows.
- The menu enters from the left. Transactional/detail surfaces enter as bottom
  sheets with an explicit close action, focus containment, safe-area padding,
  and swipe-friendly structure.
- Motion uses a short spring-like ease and respects `prefers-reduced-motion`.
- Primary tabs remain one row and horizontally scroll when necessary. Tab
  labels and actions keep at least a 44px touch target.

## Screen Requirements

### Markets and Chart

- Markets is list-first: compact filters, useful quote metadata, and rows that
  open a focused chart.
- Chart prioritizes symbol, price, chart, and Trade. Quote values wrap or size
  safely instead of ellipsizing the price.
- Supporting details use compact rows or bottom sheets rather than consuming
  the first viewport.

### Feed

- Use dense, flat signal rows with clear author, timestamp, thesis, direction,
  and Copy/Trade actions.
- Preserve the existing feed-to-trade controller path.

### Copy

- Show Feed, X callers, and Users as immediate top-level tabs.
- Rankings and follow actions appear before explanatory notices.
- Deployment warnings and risk configuration remain visible but move into
  compact disclosures or a settings sheet.

### Account

- Use a compact total and connection summary.
- Positions, Closed, Orders, Portfolio, and AI remain reachable in a single
  horizontal tab row.
- Venue sections and position/portfolio data stack into readable mobile rows;
  no table column may overlap another value or action.

## Non-Goals

- No changes to trading rules, order submission, copy execution, auth, wallet,
  market-data, or leaderboard ranking logic.
- No database migration or new production environment variables.
- No attempt to reproduce Bullpen branding or crypto-only information design.

## Verification

- Focused component tests for every changed mobile boundary.
- Web typecheck and repository lint for touched files.
- In-app browser review at 390x844 and 320x700 across Markets, Chart, Feed,
  Copy, Account tabs, Search, Menu, and Trade sheet.
- Confirm no horizontal page overflow, clipped controls, nested page scroll,
  focus escape, or new console errors.
