# DESIGN.md

Normative source of truth: `apps/web/src/index.css` and shipped components. This document records what is implemented; it introduces no new visual world.

---

title: HoboRouter web design record
source: apps/web/src/index.css (canonical), shipped components
mode: Operate (code-led, no UI board/photo comps)
visual-finish: unverified (no browser capture; see waivers)
---

## Identity

Existing "Shuffle" identity retained: refinement of incumbent brand, not replacement. Dark/light via `.dark` class (`@custom-variant dark`). Fonts: **Geist** / **Geist Mono** variable woff2 (`font-display: swap`), falling back to `ui-sans-serif, system-ui` / `ui-monospace`. System-font fallback is intentional and allowed; display fonts are impermissible — none exist, none added.

## Color tokens (actual values)

All `oklch`. Light (`:root`) / dark (`.dark`):

| Token                                             | Light                                            | Dark                                             |
| ------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| background                                        | `oklch(1 0 0)`                                   | `oklch(0.145 0 0)`                               |
| foreground                                        | `oklch(0.145 0 0)`                               | `oklch(0.985 0 0)`                               |
| card / card-foreground                            | `oklch(1 0 0)` / `oklch(0.145 0 0)`              | `oklch(0.185 0 0)` / `oklch(0.985 0 0)`          |
| popover / fg                                      | `oklch(1 0 0)` / `oklch(0.145 0 0)`              | `oklch(0.185 0 0)` / `oklch(0.985 0 0)`          |
| primary / primary-foreground                      | `oklch(0.145 0 0)` / `oklch(0.985 0 0)`          | `oklch(0.985 0 0)` / `oklch(0.145 0 0)`          |
| secondary / muted / accent (fg `0.145` / `0.985`) | `oklch(0.97 0 0)`                                | `oklch(0.26 0 0)`                                |
| muted-foreground                                  | `oklch(0.556 0 0)`                               | `oklch(0.708 0 0)`                               |
| destructive / fg                                  | `oklch(0.577 0.245 27.325)` / `oklch(0.985 0 0)` | `oklch(0.704 0.191 22.216)` / `oklch(0.985 0 0)` |
| border / input                                    | `oklch(0.922 0 0)`                               | `oklch(0.3 0 0)`                                 |
| ring                                              | `oklch(0.708 0 0)`                               | `oklch(0.556 0 0)`                               |

Neutral monochrome palette + one destructive hue. No accent color beyond neutrals; no invented colors.

## Radius & spacing

- `--radius: 0.375rem`; `radius-sm = radius−2px`, `radius-md = radius`, `radius-lg = radius+2px`.
- Spacing via Tailwind scale; page gutters `p-4 sm:p-6` (auth-layout); cards `p-4 sm:p-6`, max width `max-w-[360px]` for auth panels.
- Safe-area utilities `pt/pb/pl/pr-safe` (`env(safe-area-inset-*)`, requires `viewport-fit=cover`) for shell/overlay layers.

## Buttons & focus

`components/ui/button.tsx`: `rounded-md`, `text-sm font-medium`, `transition-colors`, disabled `opacity-50 pointer-events-none`, focus `focus-visible:ring-2 focus-visible:ring-ring` + `outline-none`. Focus is always the `ring` token.

## Motion (actual, no invented 160ms)

- View transitions (route change, `prefers-reduced-motion: no-preference`): old root fades **150ms** `cubic-bezier(0.4, 0, 0.2, 1)`; new root **200ms** `cubic-bezier(0.25, 1, 0.5, 1)` fade + 4px rise.
- Interactive elements (`a`, `button`, `[role=button]`, `aside`, `dialog`, `[data-state]`) default `transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1)`.
- Global reduced-motion guard: all animation/transition clamped to `0.01ms`, scroll-behavior auto.
- No 160ms token exists in source; not recorded as such.

## Content composition (as shipped)

- **Auth**: one layout (`components/auth-layout.tsx`) — full-screen `bg-background`, top brand row, centered `max-w-[360px]` bordered card; shared by login / signup / verify-email.
- **Charts**: `components/chart/bar-series.tsx` — SVG bars, honest zero baseline (zero day draws no bar, no stub/track), values only via caller formatter (`spend_vnd` passthrough; USD labels), sr-only data table/summary, container-measured responsive, per-bar `minStep=8` horizontal scroll for 90 days on mobile, height default 240, pads L56/R8/T12/B22. Used by Overview (spend) and Usage (metric selector: requests|tokens|spend|errors).
- **Usage page**: KPI row → full-width trend card with colocated metric selector → sortable per-model table (`@tanstack/react-table`, API order spend desc). Date filters 7/30/90 and model filter unchanged.
- **Help**: `/docs/quickstart` and `/about` render in embedded mode (skip `PublicLayout`) when reached as protected AppShell children; anonymous public access via public root routes preserved. Same page components, single content source.
- **Contact**: `instance_settings.support_email` (public catalog `support.email`) wins; fallback `DEFAULT_SUPPORT_EMAIL = "contact@hoborouter.tretrauit.me"` only when unset; null-safe rendering.
- **Promo** (`redeem-promo.tsx`): one visible `<h3>`, `sr-only` label `for="promo-code-input"`; benefit copy honest only (fixed-credit + percent top-up), EN + VI; money math server-driven.
- **States**: loading skeletons, error and empty states on touched async surfaces; honest zeros in charts; i18n en/vi inline-LocaleEntry.

## Net-code goal

Reuse-first, not a claimed overall LOC decrease.

## Waivers / unverified

- No browser pixel claims; no Impeccable ship disposition invented.
- Visual finish unverified; live OAuth credentials unconfigured.
- Runtime visuals are SVG data charts, not illustrations; no asset provenance required.

## Sidecar `.impeccable/design.json`

Not written. Reason (exact): the `reference/document.md` schema reference (`~/.agents/skills/impeccable/reference/document.md`) and the `impeccable` CLI (`~/.agents/skills/impeccable/scripts/impeccable`) exist, but the CLI ships no `document`/design.json write or schema command (its `data/` holds only font indexes; the `/document` skill is an AI-harness prompt, not a validator). No JSON schema available to validate against; a fabricated file would fake validity. Reuse of actual tokens above is recorded instead.
