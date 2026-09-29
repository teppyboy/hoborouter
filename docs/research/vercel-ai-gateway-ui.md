# Research: Vercel Dashboard / AI Gateway UI — Design Reference

## What investigated

- Public AI Gateway docs (overview, observability, logs, API keys, pricing, models-and-providers).
- Public model catalog pages (`/ai-gateway/models`, `/ai-gateway/models/page/1`).
- Dashboard routes referenced by docs (authenticated — routes documented, UI not directly observable).
- Official docs screenshots (light + dark PNGs hosted on Vercel public blob storage).

## Files changed

- `docs/research/vercel-ai-gateway-ui.md` (this file; only artifact written).

## Decisions / Findings

### Evidence provenance (critical)

- **Direct evidence:** everything fetched from vercel.com docs and public catalog pages, quoted below with exact URLs.
- **Public screenshots embedded in docs** (light/dark pairs): hosted on `7nyt0uhk7sse4zvn.public.blob.vercel-storage.com` and served via Next image proxy on vercel.com. These show real dashboard UI and are publicly viewable.
- **Inaccessible:** the live dashboard (`/dashboard/analytics/ai-gateway*`, `/[team]/~/ai-gateway/*`) requires auth. No live UI was observed directly; observations of the live dashboard come only from docs prose + doc screenshots. Nothing below is fabricated; where docs are silent, it is stated.

### 1. IA / Navigation

- Docs sidebar sections map to dashboard sidebar sections. Official doc URLs:
  - Overview: https://vercel.com/docs/ai-gateway
  - Models and providers: https://vercel.com/docs/ai-gateway/models-and-providers
  - Modalities: https://vercel.com/docs/ai-gateway/modalities
  - Observability and spend: https://vercel.com/docs/ai-gateway/observability-and-spend
  - Authentication and BYOK: https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys
  - Pricing: https://vercel.com/docs/ai-gateway/pricing
  - REST API: https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api
- Dashboard routes documented (authenticated): Overview `/[team]/~/ai-gateway`, Logs `/[team]/~/ai-gateway/logs`, API keys `/[team]/~/ai-gateway/api-keys`, project scope `/[team]/[project]/ai-gateway/logs`. Also `https://vercel.com/dashboard/analytics/ai-gateway/{quick-start,models,leaderboards,playground}` (referenced in a docs breadcrumb URL — direct evidence of route names, not of their layout). Sources: docs pages above.
- Docs describe "AI Gateway Overview section in your Vercel dashboard sidebar" with Usage and Requests subsections. Source: https://vercel.com/docs/ai-gateway/observability-and-spend/observability — direct evidence.

### 2. Overview / Usage page

- Four charts (docs text + screenshots graphs-light.png / graphs-dark.png):
  1. Requests by Model (requests per model over time)
  2. Time to First Token (avg TTFT)
  3. Input/Output Token Counts
  4. Spend (total cost over time)
- Requests section: summaries grouped by project and by API key — each row shows request count, average tokens, P75 duration, P75 TTFT, cost. Screenshot pairs: `projects-summary-light/dark.png`, `apikeys-summary-light/dark.png`. Source: https://vercel.com/docs/ai-gateway/observability-and-spend/observability — direct evidence (docs text describes the screenshots; layout inferences from screenshots are labeled interpretation).

### 3. Logs page (richest evidence)

- Table columns: Time, Status, Model, Provider, Usage, Cost, Duration, Authentication. Full column spec: https://vercel.com/docs/ai-gateway/observability-and-spend/logs — direct evidence.
- Usage cell adapts to modality (Language: `1.7K → 233 tokens`; Embedding: `23 tokens in`; Image: `4 images`; video: count/duration/resolution; speech: audio duration; rerank: query count). Hover reveals long-form breakdown. Direct evidence.
- Filter bar above table: search (model/provider/request ID) + multi-select dropdowns (Status, Model, Provider, Authentication, Routing, Modality, Request Mode, Latency, Tokens, Cost) + date presets (5 min → 30 days; 36-day max retention). Filters stored in URL. Direct evidence.
- Chart above table shows token volume (or request volume fallback); drag-to-zoom. Live tail toggle refreshes every 5 s; pagination loads 50 rows on scroll. Direct evidence.
- Row click opens resizable side details panel (URL stores selected log ID). Details: ID with copy button, auth + region + ZDR; per-attempt "Routing cards" (provider, region, served model, credential source, TTFT, timing spans, status). Timing spans color-coded: green = success, amber = 4xx, red = 5xx/timeout. Usage/Cost itemized line by line. Screenshot: `logs/request-details-light/dark.png`, `logs/async-job-details-light/dark.png`. Direct evidence.
- Exports: Copy visible logs, CSV, JSON. Running async jobs pinned to top. Direct evidence.
- Empty/permission states documented: no requests → chart empty state; role without usage-read → permission message replaces table. Direct evidence.

### 4. API Keys page

- Features: create (dashboard/CLI/API), list with last-used time, budget + spend vs limit on budgeted keys, spend attribution (User/Team), delete/revoke via row `···` menu, delete-all via header `···` menu. Source: https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys — direct evidence (docs prose; no screenshot of this page surfaced).
- Key value shown once at creation ("cannot retrieve it again"). Direct evidence.

### 5. Model catalog (fully public)

- https://vercel.com/ai-gateway/models — dense data table. Columns (direct evidence): Model (provider logo + `provider/model` link), Input price, Output price, Latency (e.g. "0.6 s"), Providers (logo stack with "+N"), ZDR, No Training, Free Tier, Capabilities, Released date. Discount badges like "50% off" / "80% off"; "Free" for free models; multi-price shown as "$X/M+2 more".
- Rows link to per-model detail pages, e.g. https://vercel.com/ai-gateway/models/gemini-3.8-flash. ~350-368 models, paginated (`/page/1` … /6). Direct evidence.
- Docs also publish a static markdown table of all models: https://vercel.com/ai-gateway (top result, "Supported Providers and Models"). Direct evidence.
- Playground at https://vercel.com/dashboard/analytics/ai-gateway/playground is authenticated — not observable.

### 6. Visual language (from official screenshots + docs)

- **Theme:** Vercel ships light AND dark screenshot pairs for every dashboard view — both themes are first-class. Monochrome-leaning: charts and tables are grayscale/near-grayscale with color used sparingly for status (green/amber/red timing spans) and discount badges.
- **Typography:** Vercel's public brand uses Geist Sans/Mono (widely published on vercel.com; the docs site itself renders in Geist). Direct evidence at site level; font family inside authenticated dashboard = interpretation from screenshots/brand consistency.
- **Layout patterns visible in screenshots:** metric cards with charts on Overview; dense horizontal-scroll data tables with filter bar above; resizable split detail panel on Logs; stacked "Routing cards" in details. Interpreted from doc screenshots (labeled).
- Not verifiable: exact spacing scale, border radii, loading/skeleton states, dashboard code-sample styling. Marked as missing evidence.

## Recommended non-clone design (minimal monochrome, static React/shadcn)

- **Structure, not styling clone.** Borrow IA: Overview (4 metric charts + group-by summaries), Logs (filter bar + dense table + resizable detail drawer with per-attempt cards), Models (dense filterable table), API Keys (table + create dialog + row menu).
- **Monochrome palette:** neutral gray scale (Tailwind `neutral`), black-on-white / white-on-dark via `dark:` classes; accent color only for status semantics (success/warn/error) and interactive states. No brand blues/gradients.
- **Type:** Geist Sans for UI, Geist Mono for model IDs, prices, timestamps, tokens. Numbers right-aligned in tables, tabular-nums.
- **Density:** compact table rows (~36-40px), small (12-13px) secondary text, filter bar as inline selects + search, date-range presets, URL-synced filters.
- **Details panel:** right-side resizable drawer with key-value rows and one card per routing attempt; horizontal timeline bars in neutral + status color.
- **shadcn mapping:** `Table`, `Tabs`, `Dialog`, `DropdownMenu`, `Select`, `Input`, `Badge` (status/discount), `Separator`, `Tooltip` (usage hover), `Skeleton` (loading), empty states as centered icon + one sentence + one action button.
- **Modality-aware usage cell:** one column whose content switches per resource type, long-form in hover tooltip.
- Keep it a design language, not a pixel copy: skip Vercel-specific geist-exact metrics, triangle-topped tooltips, and dashboard chrome.

## Tests performed

- Fetched and read 4 official doc pages + public model catalog; verified screenshot asset URLs exist in docs markup. No code tests (research-only task, no implementation permitted).

## Problems / risks

- Live dashboard not accessible without auth — all dashboard-layout claims are docs-text + doc screenshots only. Live screenshots may lag the docs or vice versa.
- Playground, leaderboards, quick-start, budgets UI pages: routes known, layouts not observed.
- Screenshots are static (no loading/skeleton states, no interaction states captured).
- Model catalog numbers (counts, prices) change frequently; treat as point-in-time.

## Suggested next steps

1. Open the 4 screenshot URL pairs from the observability and logs docs pages in a browser to inspect exact spacing/typography (URLs listed above; render through the vercel.com Next image proxy).
2. If a Vercel team account is available, screenshot `/[team]/~/ai-gateway/{,logs,api-keys}` and the playground first-hand.
3. Extract Geist font scale + Vercel design tokens from geist-ui/vercel.com CSS as second reference if pixel-fidelity ever matters.

## Key sources

- https://vercel.com/docs/ai-gateway (overview)
- https://vercel.com/docs/ai-gateway/observability-and-spend/observability
- https://vercel.com/docs/ai-gateway/observability-and-spend/logs
- https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys
- https://vercel.com/ai-gateway/models (public catalog)
- https://vercel.com/docs/ai-gateway/pricing
