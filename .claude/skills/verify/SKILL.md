---
name: verify
description: How to build, run, and drive the web app (apps/web-v2) to verify UI changes end-to-end in a real browser
---

# Verifying web-v2 UI changes

## Build & launch

- Default dev ports are **web :3000, API :3001**. These are not arbitrary:
  `apps/api/src/index.ts` seeds its CORS/CSRF trusted origins with
  `localhost:3000`/`:3001`, `apps/api/src/config/index.ts` defaults `WEB_URL`
  to `http://localhost:3000`, and the Google OAuth callback registered in the
  Cloud console points at the same origin. Changing them repo-wide breaks
  sign-in and tRPC mutations.

  ```bash
  cd apps/api && bun run dev      # :3001
  cd apps/web-v2 && bun run dev   # :3000
  ```

- If those ports are already taken on your machine, override locally instead
  of editing the committed scripts — e.g. `bun run dev -- -p 5100` — and set
  `WEB_URL` / `NEXT_PUBLIC_API_URL` in your gitignored `.env` to match.

- If the dev server 500s with `Can't resolve '@fontsource-variable/geist'`,
  run `bun install` at the repo root, then restart the dev server (webpack
  caches the failure).

## Drive the browser

- Preferred: Claude-in-Chrome MCP tools.
- Fallback if the extension is not connected: Playwright over CDP against a
  Chromium-family browser launched with `--remote-debugging-port=9222`.
  Resolve playwright from the npx cache
  (`find ~/.npm/_npx -maxdepth 3 -name playwright -type d`), import as CJS
  default (`import pkg from '<path>/index.js'; const { chromium } = pkg;`),
  then `chromium.connectOverCDP("http://localhost:9222")` and
  `browser.contexts()[0].newPage()`.
- A fresh browser profile is not signed in: `/` shows the marketing landing
  page (good for landing verification); authenticated terminal flows need you
  to sign in once in that window first.

## Gotchas

- The landing page fires one cross-origin request to the API (auth
  get-session); in a partial env it logs a single console 500 that is
  unrelated to landing-page changes.
- Text checks against the CTA feature strip must be case-insensitive; the
  strip renders uppercase via CSS so `innerText` is uppercased.
- The landing page is normal-flow (the old ~640vh pinned scroll stage was
  removed). Section headlines reveal on scroll via IntersectionObserver, so
  use `locator.scrollIntoViewIfNeeded()` before asserting on them.
- Check horizontal overflow at 1440px and 390px:
  `document.documentElement.scrollWidth > clientWidth`.
- Landing headlines animate word-by-word inside `overflow-hidden` clips and
  separate words with U+00A0, not a plain space. Assert with a normalizing
  comparison (`replace(/ /g, " ")`) rather than a raw string equality.
