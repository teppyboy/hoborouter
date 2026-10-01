# Frontend foundation handoff (page writers read this)

## Stack / conventions
- Vite+ `vp` (build/lint), TanStack Router (code-based, in `src/router.tsx`) + Query + Table v8, Zustand, RHF + Zod, shadcn/ui source in `src/components/ui`, Tailwind 4 (theme vars in `src/index.css`), Geist/Geist Mono (self-hosted woff2 in `public/fonts`), Lucide icons.
- Monochrome Vercel-style: 1px borders, small radius, no gradients. Mono font for IDs/keys/prices (`font-mono`).
- Dark/light via `class="dark"` on `<html>`; toggle cycles light→dark→system, persisted (`useThemeStore`).
- Imports use relative paths (pi-lens/oxlint checker doesn't resolve `@/` alias, though vite+tsc support it).

## Route → file map
- `/` `src/pages/overview/index.tsx`
- `/models` `src/pages/models/index.tsx` · `/models/$` (splat) `src/pages/models/detail.tsx` — public id may contain `/`; link via `modelHref(publicId)` from `src/lib/models.ts`, read the id in detail via `useParams({ strict: false })["_splat"]` (decoded).
- `/keys` `src/pages/keys/index.tsx` · `/logs` `src/pages/logs/index.tsx` · `/usage` `src/pages/usage/index.tsx`
- `/billing/credits` `src/pages/billing/credits.tsx` · `/billing/payments` `src/pages/billing/payments.tsx`
- `/settings` `src/pages/settings/index.tsx`
- `/admin/{users,models,providers,pricing,payments,system}` `src/pages/admin/<name>.tsx`
- `/login`, `/signup` `src/pages/auth/*.tsx` (real RHF+Zod forms, done)

## Shared helpers
- `src/components/page.tsx`: `PageHeader{title,description,actions}`, `EmptyState{title,description}`, `ErrorState{message?}`, `CopyButton{value,label?}`, `DataTable<TData>{columns,data,globalFilter?,onGlobalFilterChange?,empty?}` (sorting built-in).
- `src/lib/api.ts`: `api<T>(path, init)` — JSON fetch, credentials included, throws `ApiError{status,code,message}` from `{error:{code,message}}`. Example: `api<Key[]>("/api/v1/workspaces/"+workspaceId+"/keys")`.
- `src/lib/auth.ts`: `authClient`, `signIn/signUp/signOut/useSession` (Better Auth, basePath `/api/auth`, verified against `apps/api/src/app.ts`).
- `src/lib/format.ts`: `formatVnd(20000)→"20.000 ₫"`, `formatUsdMicroPer1m(1500)→"$0.0015"`, `formatTokens`, `formatDate`. Never recompute history from micros.
- `src/lib/workspace.ts` (+ `workspace-queries.ts`): `useWorkspaceStore` (persisted workspaceId) and `useWorkspaces()` (GET /api/v1/workspaces, auto-selects first). Pages: pass workspace id into every workspace-scoped query.
- `src/lib/models.ts`: `modelHref(publicId)` — link helper for the `/models/$` splat detail route (per-segment encoding).

## Endpoint prefix (backend contract change)
All control-plane endpoints now live under `/api/v1/...`. EXCEPTIONS (do NOT prefix): Better Auth `/api/auth/*`, OpenAI gateway `/v1/*`, `/webhooks/*`.

## Verified endpoints (exist today)
- `GET /api/v1/workspaces`, keys CRUD under `/api/v1/workspaces/:id/keys`, auth under `/api/auth/*`, `GET /api/v1/catalog/models` + `GET /api/v1/catalog/models/:publicId` (any signed-in user), `GET /api/v1/admin/system` (200 = admin → drives Admin nav visibility in app-shell).

## Available endpoints — render honest empty states on 404
- Session: `GET /api/v1/workspaces/:id/{usage-logs,usage-summary,wallet,ledger,payments}`; poll `GET /api/v1/workspaces/:id/payments/:paymentId`.
- Admin: `GET /api/v1/admin/{users,payments,usage-logs,cpa/models,system}`, `POST /api/v1/admin/payments/:id/complete`.
- Dev-only: `POST /api/v1/dev/payments/:id/complete` (hide button on 404).

## Billing (MOCK top-ups default)
- User: `POST /api/v1/workspaces/:id/payments {amount}` → pending → poll `GET /api/v1/workspaces/:id/payments/:paymentId`; UI shows "Waiting for admin confirmation".
- Admin > Payments: `GET /api/v1/admin/payments` + "Mark paid" → `POST /api/v1/admin/payments/:id/complete`. Dev-only "Complete (dev)" button may call `POST /api/v1/dev/payments/:id/complete` (hide on 404). No payOS UI now.

## Rules for page writers
1. Never fabricate data; empty state "Not available yet" when endpoint missing.
2. VND integers via `formatVnd`; USD micro per 1M tokens via `formatUsdMicroPer1m`.
3. Query keys: `[resource, workspaceId, ...]`. Errors → `ErrorState`, loading → `Skeleton`.
4. Placeholder pages render `null` — replace freely; keep default exports.
5. Dev proxy: `/api`, `/v1`, `/webhooks` → `http://localhost:3000`.
7. Models detail route is the splat `/models/$`; use `modelHref(publicId)` from `src/lib/models.ts` for all model links.
6. Validate: `bunx tsc -b && bunx vp build` (no unit tests for pages).
