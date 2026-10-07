# Share PNL Images

Generates a shareable 1536x1024 JPEG card for any open position or closed
trade with realized P&L. The card shows the symbol, side, qty, signed P&L in
dollars and percent, entry/exit prices, and value/cost — with an optional
"Hide $ size" mode that shows only the percentage.

## What a dev must do after pulling this change

1. **Install dependencies** (new packages: `@napi-rs/canvas`, `hono` in the worker):

   ```bash
   bun install
   ```

2. **Build the new renderer package** (the worker imports its `dist/`):

   ```bash
   bun --filter @trade-bot/pnl-image build
   ```

   (A full `bun run build` also covers this.)

3. **Add env vars** — the feature is OFF until these are set. Generate one
   secret and use the same value in both files:

   ```bash
   openssl rand -hex 32
   ```

   `apps/worker/.env`:

   ```bash
   WORKER_API_SECRET=<generated-secret>
   WORKER_HTTP_PORT=3002   # optional, 3002 is the default
   ```

   `apps/api/.env`:

   ```bash
   WORKER_HTTP_URL=http://localhost:3002
   WORKER_API_SECRET=<same-generated-secret>
   ```

4. **Restart dev processes** (`bun dev`). The worker log should print
   `Worker HTTP server listening on port 3002`.

5. **Smoke test**: open http://localhost:3000, expand an open position and
   click **Share P&L**, or click the share icon on a closed order that shows
   realized P&L. Without the env vars, the modal shows
   "Image generation service is not configured" — nothing else breaks.

No database migrations are involved in this feature.

## Architecture

```
Share button (positions panel)
  -> SharePnlModal (preview, Hide $ size, Download, Copy)
  -> tRPC pnlImage.generateOpenPosition / generateClosedOrder
  -> API resolves + validates the card values
  -> POST {WORKER_HTTP_URL}/pnl-image/generate  (X-Worker-Secret header)
  -> worker renders via @trade-bot/pnl-image (@napi-rs/canvas)
  -> base64 JPEG back to the modal
```

The API deploys to Vercel, which can't reliably run native image libraries,
so rendering happens in the long-lived worker process. The worker starts a
small private Hono HTTP server (`apps/worker/src/http/`) alongside its
pollers — **only when `WORKER_API_SECRET` is set**. Every route except
`/health` requires the `X-Worker-Secret` header.

Trust model:

- **Open positions**: the API fetches the live Alpaca position server-side;
  clients only send a symbol, so card numbers can't be fabricated.
- **Closed orders**: the client sends its history-row values (qty, fill
  price, realized P&L); the API validates them and re-derives entry price
  and percent so the card is internally consistent.

Key files:

| Area | Path |
| --- | --- |
| Renderer | `packages/pnl-image/src/` (fonts in `packages/pnl-image/assets/`) |
| Worker HTTP server | `apps/worker/src/http/server.ts`, `apps/worker/src/http/pnl-image.routes.ts` |
| API router | `apps/api/src/routers/pnl-image.ts`, `apps/api/src/lib/call-worker.ts` |
| Frontend | `apps/web-v2/src/components/trade/share-pnl-modal.tsx`, wired in `positions-panel.tsx` |

## Production deployment

1. Generate a **separate** production secret (`openssl rand -hex 32`).
2. **Worker host** (Railway/VPS/Docker): set `WORKER_API_SECRET` (and
   optionally `WORKER_HTTP_PORT`), and expose the port publicly — on Railway,
   add a public domain/TCP proxy for the service targeting the port; in
   Docker, map the port. Redeploy the worker.
3. **Vercel API project**: set `WORKER_HTTP_URL=https://<worker-host>` (or
   `http://<host>:3002` if not behind TLS) and the same `WORKER_API_SECRET`.
   Redeploy the API.
4. Verify:

   ```bash
   curl https://<worker-host>/health                      # 200 {"status":"ok"}
   curl -X POST https://<worker-host>/pnl-image/generate  # 401 without the header
   ```

If the worker host is unreachable from Vercel or env is missing, the share
button surfaces a friendly error; the rest of the app is unaffected.

## Renderer notes

- Pure `@napi-rs/canvas` (no sharp/qrcode, unlike the Olympus original). Each
  card composites over a bundled background photo: the art is zoomed/anchored
  to fill the frame, a blurred copy is dissolved in behind the stats, and a
  feathered tone lifts text contrast — all stats sit in the clean right column.
- Backgrounds live in `assets/backgrounds/` as `profit-N.jpg` (and optionally
  `loss-N.jpg`). A winning card picks a random `profit-N.jpg`; a losing card
  picks a random `loss-N.jpg`, falling back to the profit set until dedicated
  loss art exists. Add variants by dropping in more numbered files — they're
  discovered automatically, no code change.
- Bundled DejaVu fonts are registered at first render so output is identical
  in containers with no system fonts. If a bundler relocates the module, set
  `PNL_IMAGE_ASSETS_DIR=<path to packages/pnl-image/assets>`.
- Tests: `bun --filter @trade-bot/pnl-image test`.
