# STATUS

Updated 2026-10 at commit 70d23b3 (release v0.1.0, image ghcr.io/teppyboy/hoborouter:v0.1.0).

## Shipped

- PostgreSQL everywhere (drizzle-orm/bun-sql, `DATABASE_URL` required); dev/test/E2E Postgres containers (`hbr-dev-pg` :55433, `hbr-test-pg` :55432, `hbr-e2e-pg` :55434); one-time SQLite copy via `bun run db:copy-from-sqlite`.
- Paid AI gateway `/v1/chat/completions` + `/v1/responses` (auth, reservations, idempotent settlement, streaming with TTFT/latency capture, unbuffered SSE, `HBR_IDLE_TIMEOUT_S` up to 255 s), prompt caching, success rate.
- VND wallet/ledger/billing invariants; manual top-ups credited only by instance admin (Admin → Payments); payOS provider optional.
- Dashboard: overview, models/keys/logs/usage, billing, account settings (name/email/password/avatar with Gravatar fallback, 1 MiB upload), admin users add/remove, admin soft-delete of request logs (financial totals unchanged), compact audit log, CPA health detail.
- Production compose (Postgres + CPA + GHCR image), healthcheck, VPS auto-update timer with pg_dump backup and image rollback; release workflow publishes GHCR images on `v*` tags.

## QA

- 489 unit/integration tests + 40 E2E steps, all green at 70d23b3.

## Accepted residuals (still true)

- SameSite=Lax cookies without an explicit CSRF token.
- Full-hold charge on client abort after dispatch (by design).
- CPA image (`eceasy/cli-proxy-api`) runs as root upstream.

## Next steps

- payOS/VietQR integration when live credentials exist.
- Revisit CSRF token and CPA rootless image if the threat model changes.
