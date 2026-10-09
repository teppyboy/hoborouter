# UI Redesign — PRODUCT (spec)

Date: 2026-10-09. Status: approved direction (user delegated, autonomous, no interview).

## Confirmed product facts (from repo docs/code only)

- Web: React 19 + Vite, TanStack Router/Query/Table, shadcn/ui + Tailwind 4. Static build, no SSR. API: Elysia on Bun. Money: integer VND, `spend_vnd` passthrough, never recomputed.
- Public model IDs visible to clients; upstream model IDs private. Workspace privacy enforced server-side. Shuffle identity retained (existing brand/tokens/spacing/shadcn primitives preserved — refinement, not brand replacement).
- Users' workflow: log in, create API keys, use gateway, inspect usage/spend on Usage & Overview pages, top up via billing, redeem promo codes.

## Scope (>=3 seams)

### Seam 1 — Help navigation context (Tutorials/About)
- Logged-in users clicking Help group items (`/docs/quickstart`, `/about`) must stay inside AppShell (sidebar/header preserved), same public URLs, anonymous public access preserved.
- Design: embedded mode on Quickstart/About pages — skip `PublicLayout` when rendered as protected route children; public root routes stay untouched. No duplicated equal-path routes; single content source per page.
- `components/public-layout.tsx` untouched.

### Seam 2 — Contact email
- DB `instance_settings.support_email` (via public catalog `support.email`) is the truth and always wins.
- Code fallback `DEFAULT_SUPPORT_EMAIL = "contact@hoborouter.tretrauit.me"` used only when unset. Empty-safe rendering (`normalizeSupportLink` stays null-safe). No prod DB writes from code.

### Seam 3 — Promo panel (`components/redeem-promo.tsx`)
- One visible heading `<h3>`; visible duplicate `<label>` removed, replaced with `sr-only` label keeping `htmlFor="promo-code-input"`.
- New benefit copy, honest only (fixed-credit + percent top-up), EN + VI. No sitewide-discount claims; money math stays server-driven.

### Seam 4 — Usage / Overview charts
- Shared chart component (new `apps/web/src/components/chart/bar-series.tsx`): SVG, honest zero baseline (zero = zero, no 2px stubs), semantic series tokens, keyboard/touch-accessible values (sr-only summary/table), responsive by container width.
- Usage page: KPI row → full-width trend card with metric selector colocated (requests|tokens|spend|errors; one metric per axis; cost axis VND internally, USD-formatted labels) → per-model breakdown as sortable table (@tanstack/react-table, API order spend desc preserved).
- Overview adopts same component (spend series); delete divergent `fillDaily30`/hand-rolled bars.
- 90-day mobile: horizontal inspection (scroll) OR truthful aggregation, with accessible table. Date filters 7/30/90 and model filter unchanged. No new endpoints, no new deps.
- Money history never recomputed from current prices; `spend_vnd`/`upstream_cost_usd_micro` passthrough only.

### Cross-cutting
- Loading skeletons, error states, empty states for every touched async surface.
- Keyboard + touch operability; reduced-motion respected for any animation.
- i18n inline-LocaleEntry pattern, en/vi, both locales for all new copy.

## Assumptions recorded (reasonable, disclosed)
- "Shuffle identity" = existing visual brand (colors, spacing, shadcn primitives) stays; redesign is content/layout-led refinement, per code-led Operate mode.
- Embedded Help pages fetch public instance info themselves (public-queries.ts) when PublicLayout providers are absent.
- Chart file location `components/chart/` chosen by implementer; no DESIGN.md exists — incumbent code is design authority; DESIGN.md authored after redesign lands.

## Open items / dependency (separate task, not this prep)
- OAuth sign-in (Google/Discord/GitHub): user-requested. Requires auth-lane investigation first (auth docs, provider interfaces, credential/server account-link design). No auth/credential changes are made in this UI prep. UI auth-page provider buttons are owned exclusively by that future task; this redesign must not add, stub, or remove any auth controls.

## Out of scope
- API/endpoint changes, packages/*, billing logic, auth, dependencies, PRD/DESIGN authoring before implementation finishes.
