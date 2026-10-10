# Architecture docs

Current design docs. Authority for how Hoborouter fits together; requirements remain the source of truth for scope.

| Doc | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | Overall design: product/control-plane boundary vs CPA data plane, stack, runtime topology. |
| [api-boundaries.md](api-boundaries.md) | Public API surface and versioning: `/v1/*` gateway, `/api/v1/*`, `/api/auth/*`. |
| [data-model.md](data-model.md) | PostgreSQL schema, tables, money invariants, migration rules. |

Do not add new architecture docs here without owner approval; extend the existing ones.
