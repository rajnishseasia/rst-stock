# Copy Trade — Phase 1 + 3 + 4: + Top Traders leaderboard

**Branch:** `feat/copy-trade-phase4-leaderboard` — contains all of Phase 1 + 3, plus the leaderboard.

Everything above, PLUS a **Top Traders leaderboard** on its own page
**`/leaderboard`** (linked from the Copy Trade panel header) so you can vet &
discover traders before following or auto-copying:
- **Users tab:** reconstructed realized **P&L + win rate** (FIFO over shared
  trades; full **options 100x + long/short** support; fills only).
- **X Callers tab:** **forward-return + hit rate** of each caller's cashtags (via
  market-data bars; shows "—" without `ALPACA_MASTER`).
- **Follow / auto-copy directly from a row** (reuses the Phase 3 follow infra).
- Metrics are **approximate / heuristic** (labeled in-UI) — directional, not audited.

New: `leaderboard` router + `apps/api/src/lib/leaderboard.ts` + `apps/web-v2/src/app/leaderboard/page.tsx`.
Before runtime: same `bun run db:push` as Phase 3; X-caller metrics need `ALPACA_MASTER`.
