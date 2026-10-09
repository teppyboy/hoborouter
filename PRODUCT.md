# PRODUCT.md

Source: confirmed repo facts (`AGENTS.md`, `docs/requirements.md`, `docs/superpowers/specs/2026-10-09-ui-redesign.md`, code). No imagined claims; no live-data claims.

## What HoboRouter is

Private LLM gateway with a web console. API (Elysia on Bun) proxies to CLIProxyAPI upstreams; React 19 + Vite SPA (static, no SSR) is the user-facing console. TanStack Router/Query/Table, shadcn/ui + Tailwind 4.

## Money semantics

- All customer money is **integer VND**; never floats, never recomputed from current prices.
- Usage records passthrough `spend_vnd` / `upstream_cost_usd_micro`; USD is display-only (labels), VND is the unit of record.
- Ledger is append-only; wallet balance is a snapshot.

## Model privacy

- Clients see only published public model IDs. Upstream model IDs are private (server-side mapping).

## Users

- Two audiences: **end users** (API developers) who log in, create API keys, call the gateway `/v1/*`, inspect usage/spend on Usage & Overview, top up billing, redeem promos; and **instance admins** (own/operate the deployment, admin-only surfaces).
- Workspace privacy enforced server-side (workspace-scoped resources).

## Identity & auth commitment

- User directive: Vercel-inspired auth commitment — minimal, focused auth surfaces; one shared auth layout for login / signup / verify-email (`components/auth-layout.tsx`); no decorative auth chrome.
- User directive: minimum-owned-code — reuse existing primitives and patterns over adding new systems; no new dependencies without demonstrated need.
- Social sign-in (Google/Discord/GitHub) is implemented in code but requires instance-configured provider credentials; live OAuth credentials are **unconfigured** (disclosed), so email/password sign-in is the only live path.

## Visual finish status

Implementation is source-based (code-led Operate mode). No browser/pixel verification performed; visual finish is **unverified**. Runtime charts are SVG data charts (not illustrations); no image assets or provenance needed.
