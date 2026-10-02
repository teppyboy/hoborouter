# Development

See [../DEVELOPMENT.md](../DEVELOPMENT.md).

## Env

- `HBR_IDLE_TIMEOUT_S` — API server idle timeout in seconds, 1–255, default 255 (Bun maximum); Bun's 10 s default would kill streaming responses that pause between chunks (e.g. slow reasoning models).
