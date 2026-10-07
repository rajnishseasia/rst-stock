# AI Chat — Alpaca + Signa tool-call proof

End-to-end verification artifacts from PR #38 (AI Chat Phase 1 + 2).

## Plain-text transcripts (the meat)

- **`alpaca_proof.txt`** — DeepSeek calls `alpaca_get_account` + `alpaca_list_positions`
  against a real Alpaca LIVE account and synthesizes a markdown breakdown.
- **`signa-alpaca-proof.txt`** — DeepSeek calls `signa_get_signal` on each of the
  user's 4 open positions (HOOD/AMD/GME/LIN), ranks them by Signa confluence
  score, and references the user's existing limit-sell on LIN. Demonstrates the
  Alpaca + Signa tool families used together in a single turn.

Reproduce with the smoke driver:

```bash
DEEPSEEK_API_KEY=sk-... \
  bun --env-file=apps/api/.env apps/api/scripts/chat-tools-smoke.ts \
    "I own HOOD, AMD, GME, and LIN. Use signa_get_signal on each one and tell me which has the highest Signa confluence score right now."
```

## Screenshots (UI surface, signed-out state)

These show where the chat overlay and Signa Signals panel live in the dashboard.
They were captured against a local dev server without OAuth set up, so the
tool-call execution itself happens in the terminal transcripts above, not in
these screenshots.

- `dashboard-overview.png` — full dashboard with floating 🤖 button bottom-right.
- `chat-overlay-signed-out.png` — overlay opens, gates on sign-in.
- `signa-signals-panel.png` — Signa Signals left-tab content.
- `signa-signals-with-chat.png` — Signa Signals tab + chat overlay coexisting.
- `ai-chat-overlay.png`, `quick-test.png` — earlier capture iterations.
