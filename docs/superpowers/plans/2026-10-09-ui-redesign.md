# UI Redesign — implementation plan

Spec: `docs/superpowers/specs/2026-10-09-ui-redesign.md`. Mode: Operate (code-led), no UI board/questions/photo comps. All work in native child worktrees; parent allocates from clean root.

## Order (independent seams, parallelizable children)

1. **Charts (Seam 4)** — largest seam.
   - New `apps/web/src/components/chart/bar-series.tsx`: SVG bars, honest zero baseline, semantic tokens, container-responsive, sr-only accessible table/summary, reduced-motion.
   - Shared `zeroFillDaily` stays in `usage/charthelper.ts`; overview drops `fillDaily30`.
   - Usage page: KPI row → trend card with colocated metric selector → sortable per-model table (@tanstack/react-table, spend desc). USD labels via `formatUsdFromVnd ?? formatVnd`.
   - Overview adopts bar-series (spend).
   - Tests: `tests/chart-series.test.tsx` (new), extend `tests/usage-chart.test.ts`, `tests/usage-page-ui.test.tsx`; money invariant: spend_vnd passthrough only.
2. **Help context (Seam 1)** — route move + embedded mode.
   - `router.tsx`: keep public root routes; add protected children rendering same page components in embedded mode.
   - `pages/public/quickstart.tsx`, `about.tsx`: embedded mode skips `PublicLayout`, uses `Page` wrapper, self-fetches instance.
   - Tests: update `tests/nav-help-group.test.tsx`, `tests/about-page.test.tsx`, `tests/public-pages.test.tsx`, `tests/quickstart-claude-notice.test.tsx`.
3. **Contact fallback (Seam 2)** — `DEFAULT_SUPPORT_EMAIL` in `apps/web/src/lib/`, used only when `support.email` unset; `normalizeSupportLink` stays null-safe. Test: `tests/support-links` coverage of fallback + empty-safe.
4. **Promo (Seam 3)** — `redeem-promo.tsx`: one `<h3>`, sr-only label, new EN/VI benefit copy. Update `tests/promo-ui.test.tsx`.
5. **Cross-cutting pass** — loading/error/empty states, keyboard/touch, reduced motion, en/vi sweep across touched surfaces.

## Constraints per child
- No `apps/api/*`, no `packages/*`, no deps, no `lib/format.ts` signature changes.
- Conventional commits, explicit paths, narrow relevant tests before each commit.
- After web UI changes: run `impeccable detect --json <changed targets>` once at concept-selection/verification time.
- DESIGN.md authored only after implementation finishes (not premature).

## Verification gate
- `PORT=3998 bun run test` (after `bun run db:test:up`), `bun run check`, web `tsc -b`.
