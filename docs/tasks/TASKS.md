# RST Tasks — working checklist

Source of truth: [`tasks.json`](./tasks.json). Mirrors the Google Doc "🐴 RST tasks" (table rows 1–26 + freeform items 27–31).
Each executable task is shipped only after: **implement → my adversarial audit + Codex review → proof (tests/screenshots) → your confirmation → commit + mark done in the Doc.**

Status: ✅ done · ⬜ todo · 🔒 blocked (needs your input / non-code) · 🔄 in progress
Class: **C** codeable-now · **U** needs-user-input · **N** non-code · **D** already done

| ID | Row | Task | Cat | Pri | Class | Status | Group |
|----|-----|------|-----|-----|-------|--------|-------|
| T01 | 1 | See & edit the stop-loss on a position | positions | P1 | C | ✅ | G1 |
| T02 | 2 | Close-position modal (qty + limit/market) | positions | P1 | C | ✅ | G1 |
| T03 | 3 | Header shows cash + positions (not username) | header | P1 | C | ✅ | G3 |
| T04 | 4 | Closed positions view | positions | P1 | C | ✅ | G1 |
| T05 | 5 | Favicon | ui | P1 | D | ✅ | — |
| T06 | 6 | Connect paper account | trading | P1 | D | ✅ | — |
| T07 | 7 | Fix wrong relative timestamps in feed | feed | P1 | C | ⬜ | G4 |
| T08 | 8 | Friendly error on order-modify 422 | errors | P1 | C | ✅ | G5 |
| T09 | 9 | Options date/strike polish | trading | P2 | C | ✅ | G2 |
| T10 | 10 | Preserve trade-form state across tab switch | trading | P2 | C | ✅ | G2 |
| T11 | 11 | Day change colored green/red | positions | P0 | C | ✅ | G1 |
| T12 | 12 | Stock direction shouldn't say "Long (Calls)" | trading | P2 | C | ✅ | G2 |
| T13 | 13 | Rename TradeBot → Ready Set Trade | ui | P1 | D | ✅ | — |
| T14 | 14 | Account ID → Alpaca dashboard link | positions | P0 | C | ✅ | G1 |
| T15 | 15 | Twitter list + feed filter dropdown | feed | P2 | U | 🔒 | — |
| T16 | 16 | Tweet bubbles on the chart | feed | P2 | U | 🔒 | — |
| T17 | 17 | cursor:pointer on all buttons/links | ui | P0 | C | ✅ | G6 |
| T18 | 18 | Rename/move feeds + stop leaking user data | social | P1 | C | ✅ | G3/4/7 |
| T19 | 19 | Show Alpaca PNL graph | positions | P3 | U | 🔒 | — |
| T20 | 20 | Generate PNL image for trades | positions | P3 | U | 🔒 | — |
| T21 | 21 | Move TP onto main trade page (kill Manage Exits) | exits | P2 | C | ✅ | G2/G3 |
| T22 | 22 | Remove "Execute orders via Alpaca" header text | trading | P0 | C | ✅ | G2 |
| T23 | 23 | Friendly connection-error messages | errors | P1 | C | ✅ | G5 |
| T24 | 24 | Confirm modal on Cancel / Cancel-all | errors | P1 | C | ✅ | G5 |
| T25 | 25 | Refresh open orders shortly after submit | errors | P1 | C | ✅ | G5 |
| T26 | 26 | Clarify Max Risk / Stop / Quantity math + plain-English OCO | trading | P2 | C | ✅ | G2 |
| T27 | — | Signal-API feed + tiers + watchlist | feed | P3 | U | 🔒 | — |
| T28 | — | Whop affiliate self-signup + discount codes | growth | P3 | N | 🔒 | — |
| T29 | — | Twitter + landing page | growth | P2 | N | 🔒 | — |
| T30 | — | Meta + Google ads MCP | growth | P3 | N | 🔒 | — |
| T31 | — | Add more broker APIs | infra | P3 | N | 🔒 | — |

## Waves (order of execution)
- **Wave 1 — quick-wins:** T17, T22, T11, T14, T07, T18a (rename Live→X Signals)
- **Wave 2 — positions + trade-form:** T01, T02, T04, T03, T09, T10, T12, T21, T18c
- **Wave 3 — orders/errors + privacy:** T23, T08, T24, T25, T18b

## Blocked tasks — what I need from you
- **T15 (Twitter list + filter):** the list of Twitter handles (the Discord link), and whether the list is hardcoded or admin-managed.
- **T16 (tweet bubbles on chart):** a worked example of what you want it to look like. Note: the chart is the TradingView *embed* widget with no marker layer — to draw avatar bubbles we'd likely switch to `lightweight-charts` or a custom overlay. Decision needed.
- **T19 (Alpaca PNL graph):** what data/format you want (Alpaca portfolio-history API gives an equity-vs-time series) and where it should live (Account Summary card?).
- **T20 (PNL image):** you said you'd give me the code — share it and I'll wire it in.
- **T26 (risk math):** the exact intended relationship for Max Risk / Stop Loss / Quantity (formula), so I can fix + add tooltips.
- **T27 (signal-API feed / tiers / watchlist):** the signal-API source, the tier definitions (what each tier unlocks), and how "her analysis" should trigger.
- **T28–T31 (growth/brokers):** non-code or business decisions — parked.
