# Guide review — `apps/web-v2/src/app/guide/page.tsx`

Generated 2026-06-04 by a 12-agent review workflow (11 section reviewers + 1 glossary author).
Each section was fact-checked against the **current** code on `codex/local-alpaca-account-modes`.
**65 findings total · 25 high-severity.**

## Cross-cutting issues (hit almost every section)

1. **Brand rename not propagated.** The app is **"Ready Set Trade"** (`layout.tsx:28`, `page.tsx:143`) but the Guide still says **"TradeBot"** in ~9 places (overview ×2, create-alpaca, sign-in ×2, market-order, limit-order ×2, oco-order). All high-severity, all trivial.
2. **Paper vs Live account mode is undocumented.** The app now has an `AccountMode = "PAPER" | "LIVE"` toggle and **defaults to Paper** (`page.tsx:25,57,147-153`; settings `accountType` defaults PAPER). The whole Guide is written as live/real-money only — wrong in overview, create-alpaca, sign-in (missing the new **Account Type** form field), and tips.

## Per-section verdicts

| Section | Verdict | Headline problems |
|---------|---------|-------------------|
| Overview | stale | "TradeBot" brand; live-only framing; "Live Signals" → "Signals" |
| Create Alpaca | stale | titled "Live Trading Account"; no Paper path; "TradeBot" |
| Sign In & Connect | stale | "TradeBot"; signed-out is a "Sign in with Google" button (not a user icon); **missing Account Type field** |
| **Dashboard Layout** | **badly-stale** | "Live Signals"→"Signals"/"X Signals"; **"Manage Exits" tab gone → "AI Chat"**; missing Signals/Watchlist toggle, Community Trades, Open Orders panel, close-modal, editable stop |
| Market Order | minor | accurate flow; "TradeBot"; field is "Max $ Risk"; risk calc is now an opt-in **button** ("Size to $ risk → N"), not auto |
| Limit Order | minor | accurate; "TradeBot" ×2; field label "Price Trigger (Stop)" not "Price Trigger" |
| Bracket (OCO) | stale | label is **"Buy + Auto-Exits — TP + Stop (OCO)"** not "Buy + OCO (Recommended)"; R-buttons have **no** Scalp/Quick/Standard/Extended captions; add button labeled "Add"; missing "Exit plan" card name |
| Use Live Signals | stale | feed is **X/Twitter-based** (twitterapi.io, `ShardiB2`), not Discord-primary; card is "X Signals"; "View Original" / author wording off (10s refresh + 50-limit ✔) |
| Manage Positions | stale | **Close is now a modal** (qty + market/limit), not instant full close; missing editable stop loss, Open\|Closed history toggle, Alpaca account-ID link (30s refresh ✔) |
| **Set Up Exit Strategies** | **badly-stale** | **entire section describes a removed "Manage Exits" tab** + "Create Exit Strategy" button + Trail%/Trail$ inputs that no longer exist; must be rewritten to the inline OCO "Exit plan" flow or folded in |
| Tips & Notes | minor | "Live Trading" callout ignores Paper mode; mini-glossary will overlap new Glossary (market hours / AES-256) |

## Accurate as-is (no change)
OCO success message text; AAPL bracket math; Sync Mkt; 10s signal refresh + 50 limit; 30s positions refresh; market hours; AES-256; limit-order field names; Submit Order button.

## New section 12 — Glossary
42 plain-English terms in 7 collapsible groups (Order Types, Exits & Risk, Direction, Time in Force, Account, Options, Market Basics). Defines OCO, strike, call/put, contract, R-multiple, GTC/Day/IOC/FOK, bid/ask/spread/fill/slippage, Paper vs Live, etc. App-specific terms (R-math, Max $ Risk, Sync Mkt, OCO bracket-per-TP) verified against `trade-form.tsx`. Compile-safe: only `BookOpen` (already imported) + existing `SectionCard`/`CollapsibleSection`/`CalloutBox`. TOC entry: `{ id: "glossary", label: "Glossary", icon: BookOpen }`.

Full raw findings (JSON, with line numbers + suggested replacement text) captured from workflow `wf_6bd9be91-7b7`.
