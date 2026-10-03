# Development

See [../DEVELOPMENT.md](../DEVELOPMENT.md).

## Env

- `DATABASE_URL` — PostgreSQL connection URL, required in every environment (dev, tests, production); `createDb` refuses non-`postgres://` URLs. Dev/test/E2E run Postgres containers started by `bun run dev` / `bun run db:test:up` / `bun run e2e`.
- `HBR_IDLE_TIMEOUT_S` — API server idle timeout in seconds, 1–255, default 255 (Bun maximum); Bun's 10 s default would kill streaming responses that pause between chunks (e.g. slow reasoning models).
