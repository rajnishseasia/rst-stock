---
version: "0.1"
name: Ready Set Trade
description: Premium charcoal + antique-gold visual identity for a stock-trading web app

colors:
  # --- Brand core ---
  primary: "#161D26"               # Gunmetal charcoal — bull body, headers, primary actions
  on-primary: "#FFFFFF"
  primary-container: "#0C151E"     # Charcoal deep — darkest surface, pressed/hover charcoal
  on-primary-container: "#F7F5F0"

  secondary: "#C59A3E"             # Antique gold — signature accent (horns, ring, CTAs)
  on-secondary: "#0C151E"
  secondary-container: "#E7D9B4"   # Pale gold tint — badges, highlight chips
  on-secondary-container: "#3D2F0E"
  gold-highlight: "#CA9D3E"        # Metallic top sheen — focus rings, subtle gradients
  gold-shadow: "#C19436"           # Gold lower edge — gold-button hover/pressed

  # --- Trading semantics ---
  positive: "#157A52"              # Gains / up (AA-compliant on white)
  on-positive: "#FFFFFF"
  positive-container: "#D7EFE4"
  on-positive-container: "#0C3D29"
  negative: "#C0432F"              # Losses / down
  on-negative: "#FFFFFF"
  negative-container: "#F6D9D2"
  on-negative-container: "#5A1B12"

  # --- Surfaces ---
  surface: "#FFFFFF"
  on-surface: "#161D26"
  surface-container: "#F7F5F0"     # Warm off-white — cards, panels
  surface-container-high: "#EFEBE2"
  on-surface-variant: "#3A4350"    # Muted slate — secondary text, captions
  background: "#FFFFFF"
  on-background: "#0C151E"

  # --- Status & utility ---
  error: "#C0432F"
  on-error: "#FFFFFF"
  error-container: "#F6D9D2"
  on-error-container: "#5A1B12"
  outline: "#3A4350"
  outline-variant: "#D9D5CC"
  surface-tint: "#C59A3E"

typography:
  wordmark:
    fontFamily: Sora
    fontSize: 28px
    fontWeight: 700
    lineHeight: 32px
    letterSpacing: 0.14em
  display:
    fontFamily: Sora
    fontSize: 48px
    fontWeight: 700
    lineHeight: 56px
    letterSpacing: 0.01em
  headline-lg:
    fontFamily: Sora
    fontSize: 32px
    fontWeight: 700
    lineHeight: 40px
  headline-md:
    fontFamily: Sora
    fontSize: 24px
    fontWeight: 600
    lineHeight: 32px
  title-lg:
    fontFamily: Sora
    fontSize: 19px
    fontWeight: 600
    lineHeight: 26px
    letterSpacing: 0.03em
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: 400
    lineHeight: 28px
  body-md:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: 400
    lineHeight: 24px
  label-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 600
    lineHeight: 20px
    letterSpacing: 0.02em
  label-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 600
    lineHeight: 16px
    letterSpacing: 0.04em
  mono-data:
    fontFamily: IBM Plex Mono
    fontSize: 15px
    fontWeight: 500
    lineHeight: 22px

spacing:
  base: 8px
  xs: 4px
  sm: 12px
  md: 24px
  lg: 40px
  xl: 64px
  gutter: 16px
  margin: 24px

rounded:
  sm: 4px
  DEFAULT: 8px
  md: 12px
  lg: 16px
  xl: 24px
  full: 9999px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.DEFAULT}"
    padding: "{spacing.sm}"
  button-primary-hover:
    backgroundColor: "{colors.primary-container}"
    textColor: "{colors.on-primary-container}"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.on-secondary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.DEFAULT}"
    padding: "{spacing.sm}"
  button-secondary-hover:
    backgroundColor: "{colors.gold-shadow}"
    textColor: "{colors.on-secondary}"
  button-ghost:
    backgroundColor: "{colors.surface-container}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label-md}"
    rounded: "{rounded.DEFAULT}"
    padding: "{spacing.sm}"
  nav-bar:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.title-lg}"
    padding: "{spacing.sm}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  card-panel:
    backgroundColor: "{colors.surface-container}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.DEFAULT}"
    padding: "{spacing.sm}"
  chip-gain:
    backgroundColor: "{colors.positive-container}"
    textColor: "{colors.on-positive-container}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: "{spacing.xs}"
  chip-loss:
    backgroundColor: "{colors.negative-container}"
    textColor: "{colors.on-negative-container}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: "{spacing.xs}"
  badge-gold:
    backgroundColor: "{colors.secondary-container}"
    textColor: "{colors.on-secondary-container}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: "{spacing.xs}"
  ticker-up:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.positive}"
    typography: "{typography.mono-data}"
  ticker-down:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.negative}"
    typography: "{typography.mono-data}"
---

## Overview

Ready Set Trade is a stock-trading web app whose brand has to do one job above all: earn trust.
The identity is built on a **gunmetal charcoal** and **restrained antique gold** pairing — the
colors of a private bank or a vintage stock certificate, not a neon fintech startup. The mark is a
geometric bull's head whose horns rise as ascending arrows; the brand should feel **premium,
established, and confident**, never loud.

Two principles guide every screen:

1. **Gold is a seasoning, not a sauce.** It accents — a CTA, a key metric, a badge, a divider —
   never large fills. Charcoal and white/off-white carry the layout; gold marks what matters.
2. **Let data breathe.** Generous negative space and a strict 8px grid keep dense market data
   legible and calm.

Logo assets live in `../output_images/`:
- `readysettrade-logo-light.png` — bull emblem + wordmark on white (light backgrounds)
- `readysettrade-logo-dark.png` — cream bull + wordmark on charcoal (dark backgrounds)

## Colors

The palette was sampled directly from the primary logo so brand and UI stay in lockstep.

- **Primary — Charcoal `#161D26`.** The dominant brand color: top nav, primary buttons, headings.
  White on charcoal clears ~15:1 contrast, so it's safe for any text size. `primary-container`
  (`#0C151E`, "Charcoal Deep") is the pressed/hover state and the darkest body-text ink.
- **Secondary — Antique Gold `#C59A3E`.** The signature accent. It is *muted on purpose* — a warm
  metallic gold, not a bright yellow — which is what reads as "premium." Use it for the primary
  conversion CTA, key figures, the divider line under the emblem, and active states. Dark charcoal
  text on gold (`on-secondary` `#0C151E`) clears ~7.3:1. `gold-shadow` `#C19436` is the gold hover;
  `gold-highlight` `#CA9D3E` is reserved for focus rings and subtle metallic gradients.
- **Positive — Green `#157A52`** and **Negative — Red `#C0432F`.** Desaturated, premium-leaning
  versions of the standard market green/red so they don't fight the gold. Both clear WCAG AA as
  text on white (green ~5.3:1, red ~4.9:1), so they're safe at any size. The `*-container` tints
  back gain/loss chips and pills. Always still pair the color with a +/− sign or arrow — never hue
  alone.
- **Surfaces.** `surface`/`background` are pure white; `surface-container` is a warm off-white
  (`#F7F5F0`) for cards and panels — the warmth ties back to the gold. `on-surface-variant`
  (`#3A4350`) is the muted slate for secondary text and axis labels.

## Typography

Two families, hierarchy by weight and size — not by font-switching.

- **Sora** (geometric sans) for the wordmark, display, and headings. Its even, engineered geometry
  echoes the angular bull mark. The **wordmark** token is the lockup spec: uppercase, 700 weight,
  `0.14em` tracking — the same treatment as in the logo, so type set in-app matches the asset.
- **Inter** for all body copy, labels, and form text — a workhorse with excellent small-size
  legibility for dense interfaces.
- **IBM Plex Mono** (`mono-data`) for prices, P&L, and any tabular figures, so digits align in
  columns and ticks don't cause layout shift. Enable `font-variant-numeric: tabular-nums`.

## Layout

8px base grid throughout. Cards use 24px (`md`) internal padding; list rows and form fields use
12px (`sm`); section gutters are 16px. Default content max-width ~1200px with 24px page margins,
single-column on mobile expanding to multi-column dashboards on `lg+`. Keep market tables airy —
row height ≥ 44px for comfortable touch and scan-ability.

## Elevation & Depth

Light mode leans on **borders and warm surface tints** over heavy shadows — `surface-container`
panels separated by `outline-variant` (`#D9D5CC`) hairlines. Reserve a single soft shadow
(`0 4px 16px rgba(12,21,30,0.08)`) for genuinely floating elements: dropdowns, modals, the trade
ticket. Never stack multiple drop shadows; the brand reads premium through restraint.

## Shapes

Moderate, even radii — `8px` default on buttons/inputs, `12px` on cards. This is deliberately
*not* fully rounded: sharp-ish corners read as serious and financial. Full rounding (`full`) is
reserved for pills, gain/loss chips, avatars, and the circular bull badge.

## Components

- **Buttons.** `button-primary` (charcoal) is the default action. `button-secondary` (gold) is the
  *single* highest-intent CTA per view — "Start trading", "Buy". `button-ghost` for tertiary
  actions. Hover darkens (charcoal→`primary-container`, gold→`gold-shadow`); transition
  `150ms ease-out`. Min touch target 44×44px.
- **Gain/loss.** Use `ticker-up`/`ticker-down` for inline price text and `chip-gain`/`chip-loss`
  for the pill that carries the % change. Always pair color with a **+/− sign or ▲/▼ glyph** so the
  meaning survives for color-blind users — never rely on hue alone.
- **Badges.** `badge-gold` flags premium/featured items (e.g., a watchlist tier), echoing the
  metallic accent sparingly.
- **Focus.** 2px `gold-highlight` ring with a 2px offset on interactive elements for a visible,
  on-brand focus state.

## Do's and Don'ts

**Do**
- Keep gold to accents, key metrics, and one CTA per view.
- Show gains/losses with sign or arrow *and* color.
- Use `mono-data` + tabular numerals for every price and P&L figure.
- Use the dark logo (`readysettrade-logo-dark.png`) on charcoal sections.

**Don't**
- Fill large areas or hero backgrounds with gold — it cheapens instantly.
- Use bright/saturated yellow in place of the antique gold.
- Use bright, saturated green/red for gains/losses — keep the desaturated premium variants.
- Stack heavy shadows or use large border radii; the brand reads premium through restraint.
